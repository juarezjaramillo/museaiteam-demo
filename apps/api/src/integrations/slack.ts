async function api(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok?: boolean; error?: string } & Record<
    string,
    unknown
  >;
  if (!json.ok) {
    throw new Error(`Slack ${method}: ${json.error ?? "unknown"}`);
  }
  return json;
}

export async function findChannelId(
  token: string,
  name: string,
): Promise<string | null> {
  const wanted = name.replace(/^#/, "");
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const json = (await api(token, "conversations.list", {
      types: "public_channel,private_channel",
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as {
      channels?: Array<{ id: string; name: string }>;
      response_metadata?: { next_cursor?: string };
    };
    const hit = (json.channels ?? []).find((c) => c.name === wanted);
    if (hit) return hit.id;
    cursor = json.response_metadata?.next_cursor;
    if (!cursor) return null;
  }
  return null;
}

/** Metric pull: human+bot messages since ts; joins/leaves excluded. */
export async function countHistory(
  token: string,
  channel: string,
  oldest: string,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const json = (await api(token, "conversations.history", {
      channel,
      oldest,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as {
      messages?: Array<{ subtype?: string }>;
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };
    count += (json.messages ?? []).filter(
      (m) => !m.subtype || m.subtype === "bot_message",
    ).length;
    cursor = json.response_metadata?.next_cursor;
    if (!json.has_more || !cursor) break;
  }
  return count;
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
): Promise<{ channel: string; ts: string }> {
  try {
    await api(token, "conversations.join", { channel });
  } catch (err) {
    if (!String(err).includes("already_in_channel")) throw err;
  }
  const json = await api(token, "chat.postMessage", { channel, text });
  return { channel, ts: json.ts as string };
}

export async function replyToThread(
  token: string,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string> {
  const json = await api(token, "chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text,
  });
  return json.ts as string;
}

export async function deleteMessage(
  token: string,
  channel: string,
  ts: string,
): Promise<void> {
  await api(token, "chat.delete", { channel, ts });
}

export async function authTest(token: string): Promise<{ teamId: string; userId: string }> {
  const json = await api(token, "auth.test", {});
  return {
    teamId: String(json.team_id ?? ""),
    userId: String(json.user_id ?? ""),
  };
}

export async function threadReplies(
  token: string,
  channel: string,
  ts: string,
): Promise<Array<{ user: string; text: string }>> {
  const json = (await api(token, "conversations.replies", {
    channel,
    ts,
    limit: 10,
  })) as { messages?: Array<{ user?: string; text?: string; subtype?: string }> };
  return (json.messages ?? [])
    .filter((m) => !m.subtype)
    .map((m) => ({ user: m.user ?? "", text: (m.text ?? "").slice(0, 500) }));
}

export async function postDM(token: string, userId: string, text: string): Promise<void> {
  const json = (await api(token, "conversations.open", { users: userId })) as {
    channel?: { id?: string };
  };
  const channel = json.channel?.id;
  if (!channel) throw new Error("Slack conversations.open: no channel");
  await api(token, "chat.postMessage", { channel, text: text.slice(0, 3000) });
}
