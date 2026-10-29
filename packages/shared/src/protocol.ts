import { z } from "zod";

export const AgentRole = z.enum([
  "manager",
  "pm",
  "marketer",
  "engineer",
  "analyst",
  "designer",
  "qa",
  "researcher",
  "writer",
  "support",
  "ops",
]);
export type AgentRole = z.infer<typeof AgentRole>;

export const RunStatus = z.enum([
  "open",
  "queued",
  "lineup_proposed",
  "debating",
  "ruled",
  "awaiting_approval",
  "acting",
  "done",
  "halted",
  "failed",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const Proposal = z.object({
  id: z.string(),
  runId: z.string(),
  agentRole: AgentRole,
  title: z.string(),
  body: z.string(),
  artifactRefs: z.array(z.string()).default([]),
});
export type Proposal = z.infer<typeof Proposal>;

export const Vote = z.object({
  id: z.string(),
  runId: z.string(),
  proposalId: z.string(),
  agentRole: AgentRole,
  choice: z.enum(["for", "against", "abstain"]),
  reason: z.string().default(""),
});
export type Vote = z.infer<typeof Vote>;

export const Ruling = z.object({
  id: z.string(),
  runId: z.string(),
  decision: z.string(),
  rationale: z.string(),
  decidedBy: z.enum(["majority", "manager"]),
});
export type Ruling = z.infer<typeof Ruling>;

export const ActionKind = z.enum([
  "github.open_pr",
  "github.close_pr",
  "github.code_pr",
  "linear.create_issue",
  "linear.delete_issue",
  "linear.manage_issue",
  "slack.post_message",
  "slack.delete_message",
  "slack.thread_update",
  "shopify.create_discount",
  "shopify.delete_discount",
  "shopify.targeted_discount",
  "shopify.product_copy",
  "shopify.restore_product",
  "hubspot.create_note",
  "hubspot.delete_note",
  "hubspot.triage_ticket",
  "hubspot.restore_ticket",
  "hubspot.update_ticket",
  "hubspot.restore_fields",
  "hubspot.followup_note",
  "notion.create_page",
  "notion.archive_page",
  "notion.run_page",
  "mcp.tool",
]);
export type ActionKind = z.infer<typeof ActionKind>;

export const Action = z.object({
  id: z.string(),
  runId: z.string(),
  kind: ActionKind,
  target: z.string(),
  payload: z.record(z.unknown()).default({}),
  status: z.enum(["pending", "running", "done", "failed", "reverted", "skipped", "would_do"]),
  revertPayload: z.record(z.unknown()).optional(),
});
export type Action = z.infer<typeof Action>;

export const Baseline = z.object({
  title: z.string(),
  body: z.string(),
  model: z.string(),
  tokens: z.number(),
});
export type Baseline = z.infer<typeof Baseline>;

export const FeedEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("proposal"), proposal: Proposal }),
  z.object({ type: z.literal("vote"), vote: Vote }),
  z.object({ type: z.literal("ruling"), ruling: Ruling }),
  z.object({ type: z.literal("action"), action: Action }),
  z.object({ type: z.literal("status"), runId: z.string(), status: RunStatus }),
  z.object({ type: z.literal("baseline"), baseline: Baseline }),
]);
export type FeedEvent = z.infer<typeof FeedEvent>;

export const MAX_DEBATE_ROUNDS = 3;
export const VOTE_TIMEOUT_MS = 5 * 60 * 1000;
