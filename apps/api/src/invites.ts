import { isOrgRole } from "@museaiteam/shared";
import type { Env } from "./bindings.js";
import { audit } from "./db.js";
import { addMember } from "./approvals.js";

const INVITE_TTL_MS = 7 * 86_400_000;

export class BadInvite extends Error {}

export interface InviteView {
  id: string;
  email: string;
  role: string;
  accepted: boolean;
  expiresAt: string;
  createdAt: string;
}

/**
 * Owner invites a human seat. Owner itself is never grantable here —
 * the first user holds it and there is no transfer path yet.
 */
export async function createInvite(
  env: Env,
  orgId: string,
  email: string,
  role: string,
  createdBy: string,
): Promise<{ id: string; token: string; emailed: boolean }> {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
    throw new BadInvite("bad email");
  }
  if (!isOrgRole(role) || role === "owner") {
    throw new BadInvite("role must be approver or viewer");
  }
  const id = crypto.randomUUID();
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.prepare(
    `INSERT INTO invites (id, org_id, email, role, token, created_by,
       expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, orgId, clean, role, token, createdBy, new Date(Date.now() + INVITE_TTL_MS).toISOString())
    .run();
  await audit(env, null, "human", "invite.created", { org: orgId, email: clean, role });
  return { id, token, emailed: await sendInviteEmail(env, clean, role, token) };
}

async function sendInviteEmail(
  env: Env,
  email: string,
  role: string,
  token: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [email],
        subject: `You've been invited to an AI team (as ${role})`.slice(0, 120),
        text: [
          `You've been invited to join an AI team as ${role}.`,
          "",
          "1. Sign in with this email address:",
          `   ${env.APP_URL}`,
          "2. Then open your invite to join:",
          `   ${env.APP_URL}/invite/${token}`,
          "",
          "The invite ends in 7 days.",
        ].join("\n"),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listInvites(env: Env, orgId: string): Promise<InviteView[]> {
  const rows = await env.DB.prepare(
    `SELECT id, email, role, accepted, expires_at AS expiresAt,
       created_at AS createdAt FROM invites
     WHERE org_id = ? AND accepted = 0 ORDER BY rowid DESC LIMIT 100`,
  )
    .bind(orgId)
    .all<{ id: string; email: string; role: string; accepted: number; expiresAt: string; createdAt: string }>();
  return (rows.results ?? []).map((r) => ({ ...r, accepted: r.accepted === 1 }));
}

export async function revokeInvite(
  env: Env,
  orgId: string,
  inviteId: string,
): Promise<boolean> {
  const res = await env.DB.prepare("DELETE FROM invites WHERE id = ? AND org_id = ?")
    .bind(inviteId, orgId)
    .run();
  if ((res.meta.changes ?? 0) > 0) {
    await audit(env, null, "human", "invite.revoked", { org: orgId, invite: inviteId });
    return true;
  }
  return false;
}

export type AcceptOutcome =
  | { outcome: "ok"; orgId: string; role: string }
  | { outcome: "invalid" }
  | { outcome: "expired" }
  | { outcome: "used" }
  | { outcome: "mismatch" };

/**
 * Accept an invite as the signed-in user. The session email must match
 * the invited email, so forwarded links can't hijack seats.
 */
export async function acceptInvite(
  env: Env,
  token: string,
  userId: string,
  userEmail: string | null,
): Promise<AcceptOutcome> {
  const invite = await env.DB.prepare(
    "SELECT id, org_id, email, role, accepted, expires_at FROM invites WHERE token = ?",
  )
    .bind(token)
    .first<{
      id: string;
      org_id: string;
      email: string;
      role: string;
      accepted: number;
      expires_at: string;
    }>();
  if (!invite) return { outcome: "invalid" };
  if (invite.accepted === 1) return { outcome: "used" };
  if (Date.parse(invite.expires_at) < Date.now()) return { outcome: "expired" };
  if (!userEmail || userEmail.trim().toLowerCase() !== invite.email) {
    return { outcome: "mismatch" };
  }
  await addMember(env, invite.org_id, userId, invite.role);
  await env.DB.prepare("UPDATE invites SET accepted = 1 WHERE id = ?").bind(invite.id).run();
  await audit(env, null, "human", "invite.accepted", {
    org: invite.org_id,
    email: invite.email,
    role: invite.role,
  });
  return { outcome: "ok", orgId: invite.org_id, role: invite.role };
}
