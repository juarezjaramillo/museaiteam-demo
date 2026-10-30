/**
 * Box protocol: the worker↔hire-box contract. The model never sees this —
 * the worker composes every browse step, command, and file op, so
 * arbitrary model shell in a box is impossible by construction, not by
 * policy. Commands are argv arrays (no shell string exists to inject
 * into); the driver re-validates the binary allowlist and cwd.
 */

export const BOX_DRIVER_PORT = 8080;

/** Worker-composed browse steps. No free-form JS, no unbounded loops. */
export type BoxBrowseStep =
  | { op: "goto"; url: string }
  | { op: "click"; selector: string }
  | { op: "fill"; selector: string; text: string }
  | { op: "fillSecret"; selector: string; secret: string }
  | { op: "wait"; ms: number }
  | { op: "snapshot" };

export const BROWSE_STEP_CAP = 25;

export interface BoxBrowseTask {
  steps: BoxBrowseStep[];
}

/** Binaries the driver will exec. `npx` is MCP servers only, composed by us. */
export type BoxBin = "node" | "python3" | "npx";

export interface BoxCommand {
  bin: BoxBin;
  args: string[];
  /** Seconds before the driver kills it. */
  timeoutSec?: number;
}

export type BoxFileOp =
  | { op: "read"; path: string }
  | { op: "write"; path: string; body: string }
  | { op: "list"; path: string };

export interface BoxMcpCall {
  /** Unique server name (one supervised lane per name). */
  server: string;
  /** argv to spawn per call, e.g. ["-y", "@linear/mcp-server"]. */
  bin: BoxBin;
  args: string[];
  method: string;
  params?: Record<string, unknown>;
  /** Memory-only: env for this call, never written to disk. */
  secrets?: Record<string, string>;
}

export interface BoxSnapshot {
  url: string;
  title: string;
  /** Text excerpt of the page, bounded by the driver. */
  text: string;
}

export type BoxState = "running" | "sleeping" | "none";

/**
 * Estimated instance cost, cents per started hour. Estimates, not the
 * Cloudflare invoice: the meter records raw seconds and multiplies
 * here, so a rate change never rewrites history.
 */
export const BOX_RATES_CENTS_PER_HOUR: Record<string, number> = {
  lite: 3,
  basic: 6,
  standard: 12,
};

export function boxCostCents(seconds: number, instanceType: string): number {
  const rate = BOX_RATES_CENTS_PER_HOUR[instanceType] ?? BOX_RATES_CENTS_PER_HOUR.basic;
  return Math.ceil(seconds / 3600) * rate;
}

/** First http(s) URL in a mail body: the invite-accept candidate. */
export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')]+/);
  return m ? m[0].replace(/[.,;!?]+$/, "") : null;
}
