import { digestWeek } from "@museaiteam/shared";
import { z } from "zod";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import {
  type GatherResult,
  ingestGitHub,
  ingestHubSpot,
  ingestLinear,
  ingestNotion,
  ingestShopify,
  ingestSlack,
  ingestWebsite,
} from "./ingest.js";
import { listRepos } from "./integrations/github.js";
import { recall } from "./memory.js";
import { getProviderConfig, loadToken, type Provider } from "./oauth.js";
import { SparkClient } from "./spark.js";

export type GatherSource =
  | "github"
  | "hubspot"
  | "linear"
  | "notion"
  | "slack"
  | "shopify"
  | "website";

const OAUTH_SOURCES: GatherSource[] = ["github", "hubspot", "linear", "notion", "slack", "shopify"];

export async function getGatherCursor(
  env: Env,
  orgId: string,
  source: string,
): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT cursor FROM memory_gather_state WHERE org_id = ? AND source = ?",
  )
    .bind(orgId, source)
    .first<{ cursor: string }>();
  return row?.cursor ?? "";
}

export async function setGatherCursor(
  env: Env,
  orgId: string,
  source: string,
  cursor: string,
  chunks: number,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO memory_gather_state (org_id, source, cursor, chunks, gathered_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(org_id, source) DO UPDATE SET
       cursor = excluded.cursor, chunks = excluded.chunks,
       gathered_at = datetime('now')`,
  )
    .bind(orgId, source, cursor, chunks)
    .run();
}

async function gatherGitHub(env: Env, orgId: string, token: string): Promise<number> {
  const repos = await listRepos(token);
  let chunks = 0;
  for (const repo of repos) {
    const key = `github:${repo}`;
    const cursor = await getGatherCursor(env, orgId, key);
    const out = await ingestGitHub(env, orgId, token, repo, cursor);
    await setGatherCursor(env, orgId, key, out.cursor, out.chunks);
    chunks += out.chunks;
  }
  return chunks;
}

/**
 * Gather one source into org memory, incrementally. Best effort per
 * source: a failure audits and continues, never breaks the caller.
 * Returns fresh chunks stored.
 */
export async function gatherSource(
  env: Env,
  orgId: string,
  source: GatherSource,
): Promise<number> {
  try {
    if (source === "website") {
      const row = await env.DB.prepare("SELECT website_url FROM orgs WHERE id = ?")
        .bind(orgId)
        .first<{ website_url: string }>();
      const url = row?.website_url?.trim() ?? "";
      if (!url) return 0;
      const cursor = await getGatherCursor(env, orgId, "website");
      const out = await ingestWebsite(env, orgId, url, cursor);
      await setGatherCursor(env, orgId, "website", out.cursor, out.chunks);
      return out.chunks;
    }
    const token = await loadToken(env, orgId, source as Provider);
    if (!token) return 0;
    if (source === "github") return gatherGitHub(env, orgId, token);
    if (source === "shopify") {
      const cfg = await getProviderConfig(env, orgId, "shopify");
      const shop = typeof cfg.shop === "string" ? cfg.shop : "";
      if (!shop) return 0;
      const out = await ingestShopify(env, orgId, shop, token);
      await setGatherCursor(env, orgId, "shopify", "", out.chunks);
      return out.chunks;
    }
    const cursor = await getGatherCursor(env, orgId, source);
    let out: GatherResult;
    if (source === "hubspot") out = await ingestHubSpot(env, orgId, token, cursor);
    else if (source === "linear") out = await ingestLinear(env, orgId, token, cursor);
    else if (source === "notion") out = await ingestNotion(env, orgId, token, cursor);
    else out = await ingestSlack(env, orgId, token, cursor || "0");
    await setGatherCursor(env, orgId, source, out.cursor, out.chunks);
    return out.chunks;
  } catch (err) {
    await audit(env, null, "system", "gather.failed", {
      org: orgId,
      source,
      error: String(err).slice(0, 160),
    });
    return 0;
  }
}

export const PROFILE_FIELDS = [
  "icp",
  "offering",
  "customer_count",
  "employee_count",
  "help_center",
  "pricing",
  "tone",
  "competitors",
  "complaint_themes",
  "tools",
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type CompanyProfile = Record<ProfileField, string> & {
  updated_at: string;
  updated_by: string;
};

const EMPTY_PROFILE: CompanyProfile = {
  icp: "",
  offering: "",
  customer_count: "",
  employee_count: "",
  help_center: "",
  pricing: "",
  tone: "",
  competitors: "",
  complaint_themes: "",
  tools: "",
  updated_at: "",
  updated_by: "system",
};

export async function getProfile(env: Env, orgId: string): Promise<CompanyProfile> {
  const row = await env.DB.prepare("SELECT * FROM company_profile WHERE org_id = ?")
    .bind(orgId)
    .first<Record<string, string>>();
  if (!row) return { ...EMPTY_PROFILE };
  const out = { ...EMPTY_PROFILE };
  for (const f of PROFILE_FIELDS) out[f] = typeof row[f] === "string" ? row[f] : "";
  out.updated_at = row.updated_at ?? "";
  out.updated_by = row.updated_by ?? "system";
  return out;
}

export async function saveProfile(
  env: Env,
  orgId: string,
  patch: Partial<Record<ProfileField, string>>,
  updatedBy: "human" | "system",
): Promise<CompanyProfile> {
  const current = await getProfile(env, orgId);
  const next = { ...current };
  for (const f of PROFILE_FIELDS) {
    if (typeof patch[f] === "string") next[f] = (patch[f] as string).slice(0, 2000);
  }
  next.updated_by = updatedBy;
  await env.DB.prepare(
    `INSERT INTO company_profile (org_id, icp, offering, customer_count, employee_count,
      help_center, pricing, tone, competitors, complaint_themes, tools,
      updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(org_id) DO UPDATE SET
       icp = excluded.icp, offering = excluded.offering,
       customer_count = excluded.customer_count, employee_count = excluded.employee_count,
       help_center = excluded.help_center, pricing = excluded.pricing,
       tone = excluded.tone, competitors = excluded.competitors,
       complaint_themes = excluded.complaint_themes, tools = excluded.tools,
       updated_at = datetime('now'), updated_by = excluded.updated_by`,
  )
    .bind(
      orgId,
      next.icp,
      next.offering,
      next.customer_count,
      next.employee_count,
      next.help_center,
      next.pricing,
      next.tone,
      next.competitors,
      next.complaint_themes,
      next.tools,
      updatedBy,
    )
    .run();
  return next;
}

const ProfileExtract = z.object({
  icp: z.string().max(2000).optional(),
  offering: z.string().max(2000).optional(),
  customer_count: z.string().max(200).optional(),
  employee_count: z.string().max(200).optional(),
  help_center: z.string().max(2000).optional(),
  pricing: z.string().max(2000).optional(),
  tone: z.string().max(2000).optional(),
  competitors: z.string().max(2000).optional(),
  complaint_themes: z.string().max(2000).optional(),
  tools: z.string().max(2000).optional(),
});

const PROFILE_PROBES = [
  "what does the company sell and to whom",
  "ideal customer profile pricing and plans",
  "support themes and common complaints",
  "company size customers employees competitors tools",
];

/**
 * Fill empty profile fields from gathered memory. Human edits always
 * win: synthesis only writes fields that are still blank.
 */
export async function synthesizeProfile(env: Env, orgId: string): Promise<string[]> {
  const profile = await getProfile(env, orgId);
  const empty = PROFILE_FIELDS.filter((f) => !profile[f].trim());
  if (empty.length === 0) return [];
  const excerpts: string[] = [];
  for (const probe of PROFILE_PROBES) {
    const hits = await recall(env, orgId, probe, 3).catch(() => []);
    for (const h of hits) excerpts.push(`[${h.source}] ${h.text}`);
  }
  if (excerpts.length === 0) return [];
  const client = new SparkClient(env);
  const res = await client
    .chat(ProfileExtract, {
      system:
        "You extract company profile facts from memory excerpts. Reply JSON with only facts stated or strongly implied; omit anything unknown. Keep each field to a sentence or two.",
      user: `Fill these fields: ${empty.join(", ")}\n\nExcerpts:\n${excerpts.join("\n\n").slice(0, 6000)}`,
      temperature: 0,
    })
    .catch(() => null);
  if (!res) return [];
  const patch: Partial<Record<ProfileField, string>> = {};
  for (const f of empty) {
    const v = res.data[f];
    if (typeof v === "string" && v.trim()) patch[f] = v.trim();
  }
  if (Object.keys(patch).length === 0) return [];
  await saveProfile(env, orgId, patch, "system");
  await audit(env, null, "system", "profile.synthesized", {
    org: orgId,
    fields: Object.keys(patch).join(","),
  });
  return Object.keys(patch);
}

/** A fresh connection gathers immediately, then refreshes the profile. */
export async function gatherNewConnection(
  env: Env,
  orgId: string,
  source: GatherSource,
): Promise<void> {
  const chunks = await gatherSource(env, orgId, source);
  if (chunks > 0) {
    await synthesizeProfile(env, orgId).catch(() => []);
    await audit(env, null, "system", "gather.connected", { org: orgId, source, chunks });
  }
}

async function markerClaimed(env: Env, week: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT value FROM job_markers WHERE job = 'memory-gather'")
    .bind()
    .first<{ value: string }>();
  if (row?.value === week) return true;
  await env.DB.prepare(
    "INSERT INTO job_markers (job, value) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET value = excluded.value",
  )
    .bind("memory-gather", week)
    .run();
  return false;
}

/** Weekly incremental refresh across every org with connections. */
export async function tickMemoryGather(env: Env): Promise<void> {
  if (await markerClaimed(env, digestWeek())) return;
  const orgs = await env.DB.prepare("SELECT DISTINCT org_id AS id FROM oauth_tokens").all<{
    id: string;
  }>();
  const ids = new Set((orgs.results ?? []).map((r) => r.id));
  const sites = await env.DB.prepare(
    "SELECT id FROM orgs WHERE website_url IS NOT NULL AND website_url != ''",
  ).all<{ id: string }>();
  for (const r of sites.results ?? []) ids.add(r.id);
  for (const orgId of ids) {
    try {
      let fresh = 0;
      for (const source of OAUTH_SOURCES) {
        fresh += await gatherSource(env, orgId, source);
      }
      fresh += await gatherSource(env, orgId, "website");
      if (fresh > 0) await synthesizeProfile(env, orgId).catch(() => []);
    } catch (err) {
      await audit(env, null, "system", "gather.failed", {
        org: orgId,
        error: String(err).slice(0, 160),
      });
    }
  }
}
