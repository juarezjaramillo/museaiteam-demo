// Morning-brief templates. Text only: a template fills the brief box,
// the brief flows through the review ritual like any other. No
// template may grow its own code path.

export interface BriefMetric {
  name: string;
  source: string;
  note: string;
}

/**
 * The support wedge's starting brief: tonight's queue, VIPs, what to
 * hold. Prefilled when a team's brief is empty; the reviewer edits
 * and saves like any brief.
 */
export const SUPPORT_BRIEF_TEMPLATE = [
  "Tonight's queue: answer every open ticket.",
  "VIPs: customers who pay the most go first, by name.",
  "Hold: anything sensitive or angry — draft the reply, don't send.",
].join("\n");

/** First-reply time, entered by hand until a helpdesk pull exists. */
export const SUPPORT_METRIC: BriefMetric = {
  name: "first reply (minutes)",
  source: "manual",
  note: "Enter the nightly median by hand for now.",
};
