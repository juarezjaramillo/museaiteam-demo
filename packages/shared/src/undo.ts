/**
 * Undo map: every action kind the team can take back, and how. The API
 * reverts through this table; auto-review only approves kinds listed here
 * (plus a stored revert payload), so an approved-by-default action is
 * always one click away from undone. Money kinds live in words.ts and
 * always need a human even when listed here.
 */

export const INVERSE: Record<string, string> = {
  "github.open_pr": "github.close_pr",
  "github.code_pr": "github.close_pr",
  "linear.create_issue": "linear.delete_issue",
  "linear.manage_issue": "linear.delete_issue",
  "slack.post_message": "slack.delete_message",
  "slack.thread_update": "slack.delete_message",
  "shopify.create_discount": "shopify.delete_discount",
  "shopify.targeted_discount": "shopify.delete_discount",
  "shopify.product_copy": "shopify.restore_product",
  "hubspot.create_note": "hubspot.delete_note",
  "hubspot.followup_note": "hubspot.delete_note",
  "hubspot.triage_ticket": "hubspot.restore_ticket",
  "hubspot.update_ticket": "hubspot.restore_fields",
  "notion.create_page": "notion.archive_page",
  "notion.run_page": "notion.archive_page",
};

export function hasInverse(kind: string): boolean {
  return kind in INVERSE;
}
