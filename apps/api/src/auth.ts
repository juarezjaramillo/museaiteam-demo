import { Auth, type AuthConfig } from "@auth/core";
import { D1Adapter } from "@auth/d1-adapter";
import { trialWindow } from "@museaiteam/shared";
import { addMember } from "./approvals.js";
import { createTeamWithClassicSeats } from "./teams.js";
import Google from "@auth/core/providers/google";
import Resend from "@auth/core/providers/resend";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./bindings.js";

export function authConfigured(env: Env): boolean {
  return Boolean(
    (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ||
      (env.RESEND_API_KEY && env.MAIL_FROM),
  );
}

function buildConfig(env: Env): AuthConfig {
  const providers = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push(
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Google verifies emails, so linking a Google login to an existing
        // same-email account is safe — and users can't strand themselves by
        // mixing Google and magic link.
        allowDangerousEmailAccountLinking: true,
      }),
    );
  }
  if (env.RESEND_API_KEY && env.MAIL_FROM) {
    providers.push(
      Resend({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM }),
    );
  }
  return {
    secret: env.AUTH_SECRET,
    trustHost: true,
    basePath: "/api/auth",
    adapter: D1Adapter(env.DB),
    providers,
    callbacks: {
      async session({ session, user }) {
        return { ...session, user: { ...session.user, id: user.id } };
      },
    },
    events: {
      async signIn({ user }) {
        if (user?.id) {
          await ensureOrg(env, user.id, user.email ?? null);
        }
      },
    },
  };
}

/** One org per user, created on first login. Idempotent. */
export async function ensureOrg(
  env: Env,
  userId: string,
  email: string | null,
): Promise<string> {
  const existing = await env.DB.prepare(
    "SELECT id FROM orgs WHERE owner_user_id = ?",
  )
    .bind(userId)
    .first<{ id: string }>();
  if (existing) {
    await addMember(env, existing.id, userId, "owner");
    return existing.id;
  }
  const id = crypto.randomUUID();
  const name = email ? `${email.split("@")[0]}'s team` : "My team";
  // Every org is born with a fresh 14-day trial; there is no path that
  // creates one without a window.
  const window = trialWindow(Date.now());
  await env.DB.prepare(
    `INSERT INTO orgs (id, name, owner_user_id, trial_started_at, trial_ends_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, name, userId, window.startedAt, window.endsAt)
    .run();
  await createTeamWithClassicSeats(env, id);
  await addMember(env, id, userId, "owner");
  return id;
}

export async function userOrgId(
  env: Env,
  userId: string,
  email: string | null,
): Promise<string> {
  return ensureOrg(env, userId, email);
}

export async function ownsOrg(
  env: Env,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT id FROM orgs WHERE id = ? AND owner_user_id = ?",
  )
    .bind(orgId, userId)
    .first<{ id: string }>();
  return row !== null;
}

export async function authHandler(req: Request, env: Env): Promise<Response> {
  if (!authConfigured(env)) {
    return Response.json({ error: "auth not configured" }, { status: 503 });
  }
  return Auth(req, buildConfig(env));
}

export interface SessionUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

export async function getSessionUser(
  env: Env,
  req: Request,
): Promise<SessionUser | null> {
  if (!authConfigured(env)) return null;
  const sessionReq = new Request(new URL("/api/auth/session", req.url), {
    headers: req.headers,
  });
  const res = await Auth(sessionReq, buildConfig(env));
  if (!res.ok) return null;
  const json = (await res.json()) as { user?: SessionUser | null };
  return json?.user?.id ? (json.user as SessionUser) : null;
}

export const requireSession: MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: SessionUser };
}> = async (c, next) => {
  const user = await getSessionUser(c.env, c.req.raw);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
};
