import { z } from "zod";

// Shared modules stay import-free so node tests load each .ts directly;
// the sandbox test pins this list to SEAT_ROLES to stop drift.
export const SANDBOX_SEATS = [
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
] as const;

/** Ownerless org that holds sandbox sample runs. Never billed, never mailed. */
export const SANDBOX_ORG_ID = "sandbox";

/** Sample runs per IP per UTC day. The only sandbox throttle. */
export const SANDBOX_DAILY_LIMIT = 5;

/** Short vote window so a cold visitor sees a full run in ~a minute. */
export const SANDBOX_VOTE_WINDOW_MS = 10_000;

export const SandboxPreset = z.object({
  id: z.string(),
  vertical: z.string(),
  title: z.string(),
  goal: z.string(),
  metricName: z.string(),
  // Seat roles, not strings: the manager rules but never debates,
  // so a "manager" entry is a compile error instead of a dead sample run.
  squad: z.array(z.enum(SANDBOX_SEATS)).min(2).max(5),
});
export type SandboxPreset = z.infer<typeof SandboxPreset>;

/**
 * One preset per starving-crowd vertical. Squads are fixed so a sample run
 * never touches hire locks and never waits in the queue.
 */
export const SANDBOX_PRESETS: SandboxPreset[] = [
  {
    id: "saas",
    vertical: "SaaS",
    title: "Lift trial activation",
    goal: "Lift trial-to-paid activation from 32% to 37% in 14 days",
    metricName: "activation_rate",
    squad: ["pm", "engineer", "analyst", "marketer"],
  },
  {
    id: "ecom",
    vertical: "E-commerce",
    title: "Recover abandoned carts",
    goal: "Recover 12% of abandoned carts this week without discounting over 15%",
    metricName: "cart_recovery_rate",
    squad: ["marketer", "analyst", "engineer", "pm"],
  },
  {
    id: "smb",
    vertical: "Local services",
    title: "Win back quiet customers",
    goal: "Win back 20 quiet customers with personal follow-ups in 10 days",
    metricName: "winback_count",
    squad: ["support", "marketer", "ops", "pm"],
  },
];

export function sandboxPreset(id: string): SandboxPreset | undefined {
  return SANDBOX_PRESETS.find((p) => p.id === id);
}
