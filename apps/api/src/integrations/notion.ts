const NOTION_VERSION = "2022-06-28";

async function nq(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.notion.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    message?: string;
  };
  if (!res.ok) {
    throw new Error(
      `Notion ${path}: ${res.status} ${(json.message ?? JSON.stringify(json)).slice(0, 150)}`,
    );
  }
  return json;
}

export interface DecisionPage {
  id: string;
  url: string;
}

/**
 * Decision-page flagship: a titled page under the workspace page the
 * founder picked in Setup, carrying the ruling. Revert archives it.
 */
export async function createDecisionPage(
  token: string,
  parentPageId: string,
  title: string,
  paragraphs: string[],
): Promise<DecisionPage> {
  const json = await nq(token, "/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: parentPageId },
      properties: {
        title: { title: [{ text: { content: title.slice(0, 100) } }] },
      },
      children: paragraphs.map((p) => ({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: p.slice(0, 2000) } }],
        },
      })),
    }),
  });
  if (typeof json.id !== "string" || typeof json.url !== "string") {
    throw new Error("Notion page create returned no id");
  }
  return { id: json.id, url: json.url };
}

/** Metric pull: pages created since an ISO instant (search, capped).
 *  Search only sorts by last_edited_time; created <= edited always, so
 *  the first page edited before the window ends the scan soundly. */
export async function countPagesCreatedSince(
  token: string,
  since: string,
): Promise<number> {
  let count = 0;
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const json = await nq(token, "/v1/search", {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      }),
    });
    const results =
      (json.results as
        | Array<{ created_time: string; last_edited_time: string }>
        | undefined) ?? [];
    let exhausted = false;
    for (const r of results) {
      if (r.last_edited_time < since) {
        exhausted = true;
        break;
      }
      if (r.created_time >= since) count++;
    }
    if (exhausted || !json.has_more) break;
    cursor = (json.next_cursor as string | null) ?? null;
    if (!cursor) break;
  }
  return count;
}

export interface RunRecord {
  pageId: string;
  url: string;
  followupId: string;
}

const DECISIONS_DB = "AI Team Decisions";

/** Find the decisions database by title, or create it once. */
export async function ensureDecisionDb(
  token: string,
  parentPageId: string,
): Promise<string> {
  const found = await nq(token, "/v1/search", {
    method: "POST",
    body: JSON.stringify({
      query: DECISIONS_DB,
      filter: { property: "object", value: "database" },
      page_size: 5,
    }),
  });
  const hit = (
    found.results as Array<{ id: string; title?: Array<{ plain_text?: string }> }> | undefined
  )?.find((d) =>
    (d.title ?? []).some((t) => t.plain_text === DECISIONS_DB),
  );
  if (hit) return hit.id;
  const created = await nq(token, "/v1/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentPageId },
      title: [{ type: "text", text: { content: DECISIONS_DB } }],
      properties: {
        Name: { title: {} },
        Run: { rich_text: {} },
        Date: { date: {} },
        Status: {
          select: { options: [{ name: "open" }, { name: "done" }] },
        },
      },
    }),
  });
  if (typeof created.id !== "string") {
    throw new Error("Notion database create returned no id");
  }
  return created.id;
}

/**
 * One database row per run (decision + run link) with a linked follow-up
 * child page carrying the next steps.
 */
export async function createRunRecord(
  token: string,
  databaseId: string,
  name: string,
  runShort: string,
  paragraphs: string[],
  followups: string[],
): Promise<RunRecord> {
  const page = await nq(token, "/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: {
        Name: { title: [{ text: { content: name.slice(0, 100) } }] },
        Run: { rich_text: [{ text: { content: runShort } }] },
        Date: { date: { start: new Date().toISOString().slice(0, 10) } },
        Status: { select: { name: "done" } },
      },
      children: paragraphs.map((p) => ({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: p.slice(0, 2000) } }],
        },
      })),
    }),
  });
  if (typeof page.id !== "string" || typeof page.url !== "string") {
    throw new Error("Notion run record create returned no id");
  }
  const child = await nq(token, "/v1/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: page.id },
      properties: {
        title: [{ text: { content: `Follow-ups (${runShort})`.slice(0, 100) } }],
      },
      children: followups.map((p) => ({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ type: "text", text: { content: p.slice(0, 2000) } }],
          checked: false,
        },
      })),
    }),
  });
  if (typeof child.id !== "string") {
    throw new Error("Notion follow-up page create returned no id");
  }
  return { pageId: page.id, url: page.url, followupId: child.id };
}

export async function archivePage(token: string, id: string): Promise<void> {
  await nq(token, `/v1/pages/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
}
