async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors || !json.data) {
    throw new Error(
      `Linear: ${res.status} ${JSON.stringify(json.errors ?? json).slice(0, 200)}`,
    );
  }
  return json.data;
}

export async function findTeamId(
  token: string,
  name: string,
): Promise<string | null> {
  const data = await gql<{ teams: { nodes: Array<{ id: string; name: string }> } }>(
    token,
    "{ teams { nodes { id name } } }",
  );
  return data.teams.nodes.find((t) => t.name === name)?.id ?? null;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  url: string;
}

export async function createIssue(
  token: string,
  teamId: string,
  title: string,
  description: string,
): Promise<LinearIssue> {
  const data = await gql<{
    issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } };
  }>(
    token,
    `mutation($teamId: String!, $title: String!, $description: String) {
       issueCreate(input: { teamId: $teamId, title: $title, description: $description }) {
         success issue { id identifier url } } }`,
    { teamId, title, description },
  );
  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue) {
    throw new Error("Linear issueCreate returned no issue");
  }
  return issue;
}

/** Metric pull: issues not completed/canceled. Exact to 500. */
export async function countOpenIssues(
  token: string,
  teamId: string,
): Promise<{ count: number; capped: boolean }> {
  interface Page {
    team: {
      issues: {
        nodes: Array<{ id: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };
  }
  let count = 0;
  let after: string | null = null;
  for (let page = 0; page < 5; page++) {
    const data: Page = await gql<Page>(
      token,
      `query($teamId: String!, $after: String) {
         team(id: $teamId) {
           issues(filter: { state: { type: { nin: ["completed", "canceled"] } } },
             first: 100, after: $after) {
             nodes { id } pageInfo { hasNextPage endCursor } } } }`,
      { teamId, after },
    );
    count += data.team.issues.nodes.length;
    if (!data.team.issues.pageInfo.hasNextPage) return { count, capped: false };
    after = data.team.issues.pageInfo.endCursor;
  }
  return { count, capped: true };
}

export async function createSubIssue(
  token: string,
  teamId: string,
  parentId: string,
  title: string,
): Promise<LinearIssue> {
  const data = await gql<{
    issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } };
  }>(
    token,
    `mutation($teamId: String!, $parentId: String!, $title: String!) {
       issueCreate(input: { teamId: $teamId, parentId: $parentId, title: $title }) {
         success issue { id identifier url } } }`,
    { teamId, parentId, title },
  );
  const issue = data.issueCreate.issue;
  if (!data.issueCreate.success || !issue) {
    throw new Error("Linear sub-issue create returned no issue");
  }
  return issue;
}

export async function commentOnIssue(
  token: string,
  issueId: string,
  body: string,
): Promise<void> {
  const data = await gql<{ commentCreate: { success: boolean } }>(
    token,
    `mutation($issueId: String!, $body: String!) {
       commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
    { issueId, body: body.slice(0, 5000) },
  );
  if (!data.commentCreate.success) {
    throw new Error(`Linear commentCreate failed for ${issueId}`);
  }
}

/** Move an issue to the team's first state of a workflow type. */
export async function transitionIssue(
  token: string,
  teamId: string,
  issueId: string,
  type: "started" | "completed",
): Promise<string> {
  const states = await gql<{
    team: { states: { nodes: Array<{ id: string; type: string; name: string }> } };
  }>(
    token,
    `query($teamId: String!) {
       team(id: $teamId) { states { nodes { id type name } } } }`,
    { teamId },
  );
  const match = states.team.states.nodes.find(
    (s) => s.type.toLowerCase() === type,
  );
  if (!match) throw new Error(`Linear team has no ${type} state`);
  const data = await gql<{ issueUpdate: { success: boolean } }>(
    token,
    `mutation($id: String!, $stateId: String!) {
       issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
    { id: issueId, stateId: match.id },
  );
  if (!data.issueUpdate.success) {
    throw new Error(`Linear issueUpdate failed for ${issueId}`);
  }
  return match.name;
}

export async function deleteIssue(token: string, id: string): Promise<void> {
  const data = await gql<{ issueDelete: { success: boolean } }>(
    token,
    "mutation($id: String!) { issueDelete(id: $id) { success } }",
    { id },
  );
  if (!data.issueDelete.success) {
    throw new Error(`Linear issueDelete failed for ${id}`);
  }
}
