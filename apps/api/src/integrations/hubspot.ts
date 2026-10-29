async function hs(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    message?: string;
  };
  if (!res.ok) {
    throw new Error(
      `HubSpot ${path}: ${res.status} ${(json.message ?? JSON.stringify(json)).slice(0, 150)}`,
    );
  }
  return json;
}

/** Newest ticket by creation date, whatever its stage. */
export async function findNewestTicket(
  token: string,
): Promise<{ id: string; subject: string } | null> {
  const json = await hs(token, "/crm/v3/objects/tickets/search", {
    method: "POST",
    body: JSON.stringify({
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: 1,
      properties: ["subject"],
    }),
  });
  const hit = (json.results as Array<{ id: string; properties?: { subject?: string } }> | undefined)?.[0];
  if (!hit) return null;
  return { id: hit.id, subject: hit.properties?.subject ?? "(no subject)" };
}

/** Recently closed tickets, newest first, for theme mining. */
export async function recentClosedTickets(
  token: string,
  limit = 10,
): Promise<Array<{ subject: string; content: string }>> {
  const stages = await ticketStages(token);
  const closed = new Set(stages.filter((s) => s.closed).map((s) => s.id));
  const json = await hs(token, "/crm/v3/objects/tickets/search", {
    method: "POST",
    body: JSON.stringify({
      sorts: [{ propertyName: "closedate", direction: "DESCENDING" }],
      limit,
      properties: ["subject", "content", "hs_pipeline_stage"],
    }),
  });
  const results = (json.results as
    | Array<{ properties?: { subject?: string; content?: string; hs_pipeline_stage?: string } }>
    | undefined) ?? [];
  return results
    .filter((r) => closed.has(r.properties?.hs_pipeline_stage ?? ""))
    .map((r) => ({
      subject: (r.properties?.subject ?? "(no subject)").slice(0, 140),
      content: (r.properties?.content ?? "").slice(0, 400),
    }));
}

export interface TicketStage {
  id: string;
  label: string;
  closed: boolean;
}

export async function ticketStages(token: string): Promise<TicketStage[]> {
  const pipes = await hs(token, "/crm/v3/pipelines/tickets");
  const pipelines = (pipes.results as
    | Array<{
        stages: Array<{
          id: string;
          label?: string;
          metadata?: { isClosed?: unknown };
        }>;
      }>
    | undefined) ?? [];
  return pipelines
    .flatMap((p) => p.stages)
    .map((s) => ({
      id: s.id,
      label: s.label ?? s.id,
      closed: s.metadata?.isClosed === true || s.metadata?.isClosed === "true",
    }));
}

/** Newest ticket still outside closed stages. */
export async function findNewestOpenTicket(
  token: string,
): Promise<{ id: string; subject: string } | null> {
  const closed = (await ticketStages(token)).filter((s) => s.closed).map((s) => s.id);
  const json = await hs(token, "/crm/v3/objects/tickets/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups:
        closed.length > 0
          ? [
              {
                filters: [
                  {
                    propertyName: "hs_pipeline_stage",
                    operator: "NOT_IN",
                    values: closed,
                  },
                ],
              },
            ]
          : [],
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: 1,
      properties: ["subject"],
    }),
  });
  const hit = (json.results as Array<{ id: string; properties?: { subject?: string } }> | undefined)?.[0];
  if (!hit) return null;
  return { id: hit.id, subject: hit.properties?.subject ?? "(no subject)" };
}

export interface TicketFields {
  priority: string | null;
  stage: string | null;
}

export async function getTicketFields(
  token: string,
  ticketId: string,
): Promise<TicketFields> {
  const json = await hs(
    token,
    `/crm/v3/objects/tickets/${ticketId}?properties=hs_ticket_priority,hs_pipeline_stage`,
  );
  const props = (json.properties as Record<string, unknown> | undefined) ?? {};
  return {
    priority:
      typeof props.hs_ticket_priority === "string" ? props.hs_ticket_priority : null,
    stage:
      typeof props.hs_pipeline_stage === "string" ? props.hs_pipeline_stage : null,
  };
}

export async function updateTicketFields(
  token: string,
  ticketId: string,
  fields: { priority?: string; stage?: string },
): Promise<void> {
  const properties: Record<string, string> = {};
  if (fields.priority) properties.hs_ticket_priority = fields.priority;
  if (fields.stage) properties.hs_pipeline_stage = fields.stage;
  if (Object.keys(properties).length === 0) return;
  await hs(token, `/crm/v3/objects/tickets/${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

/** Metric pull: tickets outside closed pipeline stages (search total). */
export async function countOpenTickets(token: string): Promise<number> {
  const closed = (await ticketStages(token)).filter((s) => s.closed).map((s) => s.id);
  const json = await hs(token, "/crm/v3/objects/tickets/search", {
    method: "POST",
    body: JSON.stringify({
      filterGroups:
        closed.length > 0
          ? [
              {
                filters: [
                  {
                    propertyName: "hs_pipeline_stage",
                    operator: "NOT_IN",
                    values: closed,
                  },
                ],
              },
            ]
          : [],
      limit: 1,
    }),
  });
  return typeof json.total === "number" ? json.total : 0;
}

/** Triage flagship: a note with the team's call, pinned to a ticket. */
export async function createNote(
  token: string,
  body: string,
): Promise<string> {
  const json = await hs(token, "/crm/v3/objects/notes", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: String(Date.now()),
        hs_note_body: body,
      },
    }),
  });
  if (typeof json.id !== "string") {
    throw new Error("HubSpot note create returned no id");
  }
  return json.id;
}

export async function associateNoteToTicket(
  token: string,
  noteId: string,
  ticketId: string,
): Promise<void> {
  // Associations v4: the v3 `/types/<name>` URL form 404s. 228 is the
  // HUBSPOT_DEFINED note→ticket association type.
  await hs(
    token,
    `/crm/v4/objects/notes/${noteId}/associations/tickets/${ticketId}`,
    {
      method: "PUT",
      body: JSON.stringify([
        { associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 },
      ]),
    },
  );
}

export async function getTicketContent(
  token: string,
  ticketId: string,
): Promise<string> {
  const json = await hs(
    token,
    `/crm/v3/objects/tickets/${ticketId}?properties=content`,
  );
  const props = json.properties as { content?: unknown } | undefined;
  return typeof props?.content === "string" ? props.content : "";
}

export async function updateTicketContent(
  token: string,
  ticketId: string,
  content: string,
): Promise<void> {
  await hs(token, `/crm/v3/objects/tickets/${ticketId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: { content } }),
  });
}

export async function deleteNote(token: string, id: string): Promise<void> {
  await hs(token, `/crm/v3/objects/notes/${id}`, { method: "DELETE" });
}

/**
 * HubSpot answers missing grants with 403 + "scope" in the message (some
 * accounts can't even offer the notes scope). That is a configuration
 * state, not a crash: callers record it as skipped, not failed.
 */
export function isScopeError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("403") && /scope/i.test(msg);
}
