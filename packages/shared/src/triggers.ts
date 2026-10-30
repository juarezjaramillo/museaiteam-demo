/**
 * The fixed ownership trigger: one rule for every goal, no knobs. A
 * hire starts digging when the number really moved (10%+ off the
 * trailing median) or went flat (last 5 points identical over 48h+).
 * Fewer than 3 points means "no numbers", never a trigger — the
 * caller flags the gap instead of acting blind.
 */

export interface TriggerPoint {
  ts: string;
  value: number;
}

export type TriggerVerdict =
  | { fired: false }
  | { fired: true; reason: string };

export const TRIGGER_MIN_POINTS = 3;
export const TRIGGER_MOVE_PCT = 10;
export const TRIGGER_FLAT_POINTS = 5;
export const TRIGGER_FLAT_SPAN_MS = 48 * 3600 * 1000;
export const TRIGGER_STALE_MS = 14 * 24 * 3600 * 1000;

function parseTs(ts: string): number {
  // Metric points store SQLite datetime('now') — UTC without a marker.
  // Bind it to UTC explicitly so local timezones can't skew staleness.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(ts)) {
    return Date.parse(`${ts.replace(" ", "T")}Z`);
  }
  const direct = Date.parse(ts);
  return Number.isFinite(direct) ? direct : NaN;
}

export function evaluateTrigger(points: TriggerPoint[]): TriggerVerdict {
  if (points.length < TRIGGER_MIN_POINTS) return { fired: false };
  const values = points.map((p) => p.value);
  const latest = values[values.length - 1];
  const window = values.slice(-7);
  const sorted = [...window].sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length / 2)];
  if (baseline === 0) {
    if (latest !== 0) {
      return { fired: true, reason: `moved off zero to ${latest}` };
    }
  } else {
    const pct = Math.abs((latest - baseline) / baseline) * 100;
    if (pct >= TRIGGER_MOVE_PCT) {
      const dir = latest > baseline ? "up" : "down";
      return {
        fired: true,
        reason: `${dir} ${Math.round(pct)}% (was ${baseline}, now ${latest})`,
      };
    }
  }
  const last = values.slice(-TRIGGER_FLAT_POINTS);
  if (last.length === TRIGGER_FLAT_POINTS && last.every((v) => v === last[0])) {
    const span =
      parseTs(points[points.length - 1].ts) -
      parseTs(points[points.length - TRIGGER_FLAT_POINTS].ts);
    if (Number.isFinite(span) && span >= TRIGGER_FLAT_SPAN_MS) {
      const days = Math.max(2, Math.round(span / (24 * 3600 * 1000)));
      return { fired: true, reason: `flat at ${last[0]} for ${days} days` };
    }
  }
  return { fired: false };
}

/** True when the feed went quiet: latest point older than 14 days. */
export function isTriggerStale(points: TriggerPoint[], nowMs: number): boolean {
  if (points.length === 0) return true;
  const latest = parseTs(points[points.length - 1].ts);
  if (!Number.isFinite(latest)) return false;
  return nowMs - latest > TRIGGER_STALE_MS;
}
