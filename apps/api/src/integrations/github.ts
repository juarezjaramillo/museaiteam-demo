async function gh(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "museaiteam",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const granted = res.headers.get("x-oauth-scopes") ?? "none";
    const accepted = res.headers.get("x-accepted-oauth-scopes") ?? "none";
    throw new Error(
      `GitHub ${path}: ${res.status} ${(await res.text()).slice(0, 150)} [granted: ${granted}; accepted: ${accepted}]`,
    );
  }
  return res;
}

export interface PlanPr {
  number: number;
  url: string;
  branch: string;
}

/** Branch from default HEAD; retries reuse an existing branch. */
async function ensureBranch(
  token: string,
  repo: string,
  branch: string,
): Promise<void> {
  try {
    await gh(token, `/repos/${repo}/git/ref/heads/${branch}`);
    return;
  } catch {
    /* branch missing — create it below */
  }
  const info = (await (
    await gh(token, `/repos/${repo}`)
  ).json()) as { default_branch: string };
  const ref = (await (
    await gh(token, `/repos/${repo}/git/ref/heads/${info.default_branch}`)
  ).json()) as { object: { sha: string } };
  await gh(token, `/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
  });
}

export async function openPlanPr(
  token: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  title: string,
  body: string,
): Promise<PlanPr> {
  const info = (await (
    await gh(token, `/repos/${repo}`)
  ).json()) as { default_branch: string };
  await ensureBranch(token, repo, branch);
  let bytes = "";
  const utf8 = new TextEncoder().encode(content);
  for (const b of utf8) bytes += String.fromCharCode(b);
  await gh(token, `/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: title,
      content: btoa(bytes),
      branch,
    }),
  });
  const pr = (await (
    await gh(token, `/repos/${repo}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        head: branch,
        base: info.default_branch,
        body,
      }),
    })
  ).json()) as { number: number; html_url: string };
  return { number: pr.number, url: pr.html_url, branch };
}

/** Metric pull: exact PR totals via the search API. */
export async function searchPrCount(
  token: string,
  repo: string,
  extra: string,
): Promise<number> {
  const q = encodeURIComponent(`repo:${repo} type:pr ${extra}`);
  const json = (await (
    await gh(token, `/search/issues?q=${q}&per_page=1`)
  ).json()) as { total_count?: number };
  return json.total_count ?? 0;
}

/** Repo context for the engineer: capped recursive tree + file reads. */
export async function readTree(token: string, repo: string): Promise<string[]> {
  const info = (await (
    await gh(token, `/repos/${repo}`)
  ).json()) as { default_branch: string };
  const tree = (await (
    await gh(
      token,
      `/repos/${repo}/git/trees/${info.default_branch}?recursive=1`,
    )
  ).json()) as { tree?: Array<{ path?: string; type?: string }> };
  return (tree.tree ?? [])
    .filter((e) => e.type === "blob" && e.path)
    .map((e) => e.path as string)
    .filter((p) => !p.includes("node_modules/") && !p.startsWith(".git/"))
    .slice(0, 200);
}

export async function readFile(
  token: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        accept: "application/vnd.github.raw",
        authorization: `Bearer ${token}`,
        "user-agent": "museaiteam",
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub read ${path}: ${res.status} ${(await res.text()).slice(0, 150)}`);
  }
  return (await res.text()).slice(0, 20_000);
}

/**
 * Real code PR: branch + up to N files (create or overwrite) + PR. The
 * branch starts at default HEAD, so the PR opens mergeable by
 * construction — no patch application, no conflicts.
 */
export async function openCodePr(
  token: string,
  repo: string,
  branch: string,
  files: Array<{ path: string; content: string }>,
  title: string,
  body: string,
): Promise<PlanPr> {
  const info = (await (
    await gh(token, `/repos/${repo}`)
  ).json()) as { default_branch: string };
  await ensureBranch(token, repo, branch);
  for (const f of files) {
    const utf8 = new TextEncoder().encode(f.content);
    let bytes = "";
    for (const b of utf8) bytes += String.fromCharCode(b);
    let sha: string | undefined;
    try {
      const existing = (await (
        await gh(token, `/repos/${repo}/contents/${f.path}?ref=${branch}`)
      ).json()) as { sha?: string };
      sha = existing.sha;
    } catch {
      /* file does not exist yet — create it */
    }
    await gh(token, `/repos/${repo}/contents/${f.path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: title,
        content: btoa(bytes),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
  }
  const pr = (await (
    await gh(token, `/repos/${repo}/pulls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        head: branch,
        base: info.default_branch,
        body,
      }),
    })
  ).json()) as { number: number; html_url: string };
  return { number: pr.number, url: pr.html_url, branch };
}

export async function closePlanPr(
  token: string,
  repo: string,
  pr: number,
  branch: string,
): Promise<void> {
  await gh(token, `/repos/${repo}/pulls/${pr}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state: "closed" }),
  });
  await gh(token, `/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
}
