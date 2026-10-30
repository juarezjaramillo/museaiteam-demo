import type { Env } from "./bindings.js";
import { audit, getRun } from "./db.js";
import { getProviderConfig } from "./oauth.js";
import { hireToken } from "./seat-creds.js";
import { closePlanPr } from "./integrations/github.js";
import { deleteIssue } from "./integrations/linear.js";
import { deleteMessage } from "./integrations/slack.js";
import {
  deleteDiscountCode,
  updateProductDescription,
} from "./integrations/shopify.js";
import {
  deleteNote,
  updateTicketContent,
  updateTicketFields,
} from "./integrations/hubspot.js";
import { archivePage } from "./integrations/notion.js";
import { INVERSE } from "@museaiteam/shared";

interface ActionRow {
  id: string;
  kind: string;
  target: string;
  revert_payload: string | null;
}

/**
 * True when the same run created the Linear issue. A manage action on a
 * pre-existing issue must never delete the parent — only what the run
 * added (subtasks) goes away.
 */
function runMadeIssue(rows: ActionRow[], issueId: string): boolean {
  return rows.some((o) => {
    if (o.kind !== "linear.create_issue" || !o.revert_payload) return false;
    try {
      return (
        (JSON.parse(o.revert_payload) as { issueId?: unknown }).issueId ===
        issueId
      );
    } catch {
      return false;
    }
  });
}

/** True when the same run posted the Slack parent message. */
function runPostedTs(rows: ActionRow[], ts: string): boolean {
  return rows.some((o) => {
    if (o.kind !== "slack.post_message" || !o.revert_payload) return false;
    try {
      return (JSON.parse(o.revert_payload) as { ts?: unknown }).ts === ts;
    } catch {
      return false;
    }
  });
}

export async function executeRevert(
  env: Env,
  orgId: string,
  runId: string,
): Promise<{ reverted: string[]; failed: Array<{ id: string; error: string }> }> {
  // Reverts run as the author's seat: same identity that made the mess.
  const teamId = (await getRun(env, runId))?.team_id ?? null;
  const rows = await env.DB.prepare(
    "SELECT id, kind, target, revert_payload FROM actions WHERE run_id = ? AND status = 'done' ORDER BY rowid DESC",
  )
    .bind(runId)
    .all<ActionRow>();
  const reverted: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const row of rows.results ?? []) {
    const inverse = INVERSE[row.kind];
    if (!inverse || !row.revert_payload) {
      await audit(env, runId, "human", "revert.skipped", {
        action: row.id,
        kind: row.kind,
      });
      continue;
    }
    try {
      const rp = JSON.parse(row.revert_payload) as Record<string, unknown>;
      if (row.kind === "github.open_pr" || row.kind === "github.code_pr") {
        const token = await hireToken(env, orgId, teamId, "github");
        if (!token) throw new Error("github not connected");
        await closePlanPr(
          token,
          String(rp.repo),
          Number(rp.pr),
          String(rp.branch),
        );
      } else if (row.kind === "linear.create_issue" || row.kind === "linear.manage_issue") {
        const token = await hireToken(env, orgId, teamId, "linear");
        if (!token) throw new Error("linear not connected");
        const subs = Array.isArray(rp.subIds) ? rp.subIds : [];
        for (const sub of subs) {
          try {
            await deleteIssue(token, String(sub));
          } catch {
            /* parent delete may cascade; best-effort either way */
          }
        }
        if (
          row.kind === "linear.create_issue" ||
          runMadeIssue(rows.results ?? [], String(rp.issueId))
        ) {
          await deleteIssue(token, String(rp.issueId));
        } else {
          await audit(env, runId, "human", "revert.kept_parent", {
            action: row.id,
            kind: row.kind,
          });
        }
      } else if (row.kind === "slack.post_message" || row.kind === "slack.thread_update") {
        const token = await hireToken(env, orgId, teamId, "slack");
        if (!token) throw new Error("slack not connected");
        const replies = Array.isArray(rp.replies) ? rp.replies : [];
        for (const ts of replies) {
          try {
            await deleteMessage(token, String(rp.channel), String(ts));
          } catch {
            /* parent delete may take the thread; best-effort */
          }
        }
        if (
          row.kind === "slack.post_message" ||
          runPostedTs(rows.results ?? [], String(rp.ts))
        ) {
          await deleteMessage(token, String(rp.channel), String(rp.ts));
        } else {
          await audit(env, runId, "human", "revert.kept_parent", {
            action: row.id,
            kind: row.kind,
          });
        }
      } else if (
        row.kind === "shopify.create_discount" ||
        row.kind === "shopify.targeted_discount"
      ) {
        const token = await hireToken(env, orgId, teamId, "shopify");
        if (!token) throw new Error("shopify not connected");
        const { shop } = await getProviderConfig(env, orgId, "shopify");
        if (typeof shop !== "string" || !shop) {
          throw new Error("shopify shop not configured");
        }
        await deleteDiscountCode(shop, token, String(rp.id));
      } else if (row.kind === "shopify.product_copy") {
        const token = await hireToken(env, orgId, teamId, "shopify");
        if (!token) throw new Error("shopify not connected");
        const { shop } = await getProviderConfig(env, orgId, "shopify");
        if (typeof shop !== "string" || !shop) {
          throw new Error("shopify shop not configured");
        }
        await updateProductDescription(shop, token, String(rp.productId), String(rp.priorDescription ?? ""));
      } else if (row.kind === "hubspot.create_note" || row.kind === "hubspot.followup_note") {
        const token = await hireToken(env, orgId, teamId, "hubspot");
        if (!token) throw new Error("hubspot not connected");
        await deleteNote(token, String(rp.noteId));
      } else if (row.kind === "hubspot.triage_ticket") {
        const token = await hireToken(env, orgId, teamId, "hubspot");
        if (!token) throw new Error("hubspot not connected");
        await updateTicketContent(token, String(rp.ticketId), String(rp.priorContent ?? ""));
      } else if (row.kind === "hubspot.update_ticket") {
        const token = await hireToken(env, orgId, teamId, "hubspot");
        if (!token) throw new Error("hubspot not connected");
        await updateTicketFields(token, String(rp.ticketId), {
          ...(rp.priorPriority ? { priority: String(rp.priorPriority) } : {}),
          ...(rp.priorStage ? { stage: String(rp.priorStage) } : {}),
        });
      } else if (row.kind === "notion.create_page") {
        const token = await hireToken(env, orgId, teamId, "notion");
        if (!token) throw new Error("notion not connected");
        await archivePage(token, String(rp.pageId));
      } else if (row.kind === "notion.run_page") {
        const token = await hireToken(env, orgId, teamId, "notion");
        if (!token) throw new Error("notion not connected");
        if (rp.followupId) {
          try {
            await archivePage(token, String(rp.followupId));
          } catch {
            /* parent archive may cascade; best-effort */
          }
        }
        await archivePage(token, String(rp.pageId));
      }
      await env.DB.prepare("UPDATE actions SET status = 'reverted' WHERE id = ?")
        .bind(row.id)
        .run();
      await env.DB.prepare(
        `INSERT INTO actions (id, run_id, kind, target, payload, status)
         VALUES (?, ?, ?, ?, ?, 'done')`,
      )
        .bind(crypto.randomUUID(), runId, inverse, row.target, "{}")
        .run();
      reverted.push(row.id);
    } catch (err) {
      failed.push({ id: row.id, error: String(err).slice(0, 200) });
      await audit(env, runId, "human", "revert.failed", {
        action: row.id,
        error: String(err).slice(0, 200),
      });
    }
  }
  await audit(env, runId, "human", "revert.done", {
    reverted: reverted.length,
    failed: failed.length,
  });
  return { reverted, failed };
}
