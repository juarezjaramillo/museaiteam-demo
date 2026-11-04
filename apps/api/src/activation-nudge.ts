import { providerFetch } from "./integrations/http.js";

export const ACTIVATION_BASELINE_PCT = 32;
export const ACTIVATION_TARGET_PCT = 37;
export const RAZOR_NUDGE_NAME = "Razor Activation Nudge 32 to 37";

export interface RazorNudgeInput {
  subject: string;
  fromName: string;
  replyTo: string;
  htmlBody: string;
  ctaText: string;
  ctaUrl: string;
}

export interface RazorNudgeResult {
  emailId: string;
  workflowId: string;
  previewUrl: string;
  workflowStatus: "ACTIVE";
  baselinePct: number;
  targetPct: number;
}

async function hsPost(
  token: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await providerFetch("HubSpot", `https://api.hubapi.com${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
    message?: string;
  };
  if (!res.ok) {
    const detail =
      typeof json.message === "string" ? json.message : JSON.stringify(json);
    throw new Error(`HubSpot ${path}: ${res.status} ${detail.slice(0, 150)}`);
  }
  return json;
}

export function previewUrlForEmail(emailId: string): string {
  return `https://app.hubspot.com/email/${encodeURIComponent(emailId)}/preview`;
}

function requireInput(input: RazorNudgeInput): void {
  if (!input.subject.trim()) throw new Error("subject is required");
  if (!input.fromName.trim()) throw new Error("fromName is required");
  if (!input.replyTo.trim()) throw new Error("replyTo is required");
  if (!input.htmlBody.trim()) throw new Error("htmlBody is required");
  if (!input.ctaText.trim()) throw new Error("ctaText is required");
  if (!/^https:\/\//.test(input.ctaUrl)) throw new Error("ctaUrl must be https");
}

/** Create exactly one live marketing email for the razor nudge. */
export async function createRazorEmail(
  token: string,
  input: RazorNudgeInput,
): Promise<{ emailId: string; previewUrl: string }> {
  requireInput(input);
  const json = await hsPost(token, "/marketing/v3/emails", {
    name: RAZOR_NUDGE_NAME,
    subject: input.subject,
    from: { fromName: input.fromName, replyTo: input.replyTo },
    content: {
      htmlBody: input.htmlBody,
      ctaText: input.ctaText,
      ctaUrl: input.ctaUrl,
    },
    baselinePct: ACTIVATION_BASELINE_PCT,
    targetPct: ACTIVATION_TARGET_PCT,
  });
  const emailId = String(json.id ?? json.emailId ?? "");
  if (!emailId) throw new Error("HubSpot email create: missing id");
  return { emailId, previewUrl: previewUrlForEmail(emailId) };
}

/** Create exactly one ACTIVE contact workflow with a single send action. */
export async function createRazorWorkflow(
  token: string,
  emailId: string,
): Promise<{ workflowId: string }> {
  if (!emailId.trim()) throw new Error("emailId is required");
  const json = await hsPost(token, "/automation/v4/flows", {
    name: RAZOR_NUDGE_NAME,
    type: "CONTACT_BASED",
    status: "ACTIVE",
    baselinePct: ACTIVATION_BASELINE_PCT,
    targetPct: ACTIVATION_TARGET_PCT,
    actions: [{ type: "SEND_EMAIL", emailId }],
  });
  const workflowId = String(json.id ?? json.flowId ?? "");
  if (!workflowId) throw new Error("HubSpot workflow create: missing id");
  return { workflowId };
}

/**
 * Ship the razor keystone: 1 live email + 1 ACTIVE workflow.
 * Single send only, tied to 32 -> 37 activation.
 */
export async function shipRazorActivationNudge(
  token: string,
  input: RazorNudgeInput,
): Promise<RazorNudgeResult> {
  const { emailId, previewUrl } = await createRazorEmail(token, input);
  const { workflowId } = await createRazorWorkflow(token, emailId);
  return {
    emailId,
    workflowId,
    previewUrl,
    workflowStatus: "ACTIVE",
    baselinePct: ACTIVATION_BASELINE_PCT,
    targetPct: ACTIVATION_TARGET_PCT,
  };
}
