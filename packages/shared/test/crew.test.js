import test from "node:test";
import assert from "node:assert/strict";
import { crewName, CREW, hireDisplayName, ownerFor, roleLabel } from "../src/crew.ts";
import { buildProof } from "../src/proof.ts";
import { actionLabel } from "../src/words.ts";
const proof = (kind, target, status, rp, p) =>
  buildProof(kind, target, status, actionLabel(kind), rp, p);

test("every seat and the manager has a name", () => {
  for (const role of ["manager", "pm", "marketer", "engineer", "analyst", "designer", "qa", "researcher", "writer", "support", "ops"]) {
    assert.ok(CREW[role], role);
    assert.equal(crewName(role), CREW[role]);
  }
  assert.equal(crewName("mystery"), "mystery");
});

test("hire display names carry the AI tag", () => {
  assert.equal(hireDisplayName("analyst"), "Priya (AI)");
  assert.equal(hireDisplayName("mystery"), "mystery (AI)");
});

test("role labels read as job titles", () => {
  assert.equal(roleLabel("pm"), "PM");
  assert.equal(roleLabel("qa"), "QA");
  assert.equal(roleLabel("engineer"), "Engineer");
  assert.equal(roleLabel("manager"), "Manager");
  assert.equal(roleLabel("mystery"), "Mystery");
});

test("action kinds map to the seat whose limits authorized them", () => {
  assert.equal(ownerFor("github.open_pr"), "engineer");
  assert.equal(ownerFor("linear.create_issue"), "pm");
  assert.equal(ownerFor("slack.post_message"), "marketer");
  assert.equal(ownerFor("shopify.create_discount"), "marketer");
  assert.equal(ownerFor("hubspot.triage_ticket"), "analyst");
  assert.equal(ownerFor("notion.create_page"), "pm");
  assert.equal(ownerFor("creative.campaign_image"), "marketer");
  assert.equal(ownerFor("acme.future"), "manager");
});

test("proof covers finished results, null otherwise", () => {
  assert.equal(proof("github.open_pr", "x", "skipped"), null);
  assert.equal(proof("github.open_pr", "x", "failed"), null);
  const pr = proof("github.open_pr", "https://github.com/o/r/pull/3", "done", { pr: 3, repo: "o/r" });
  assert.equal(pr.summary, "Opened pull request #3 in o/r");
  assert.equal(pr.url, "https://github.com/o/r/pull/3");
  const sub = proof("linear.manage_issue", "t", "done", { subIds: ["a", "b"] });
  assert.equal(sub.summary, "Added 2 subtasks to a task");
  const ticket = proof("hubspot.update_ticket", "t", "done", { priorStage: "1" }, { stage: "2" });
  assert.equal(ticket.summary, "Updated a support ticket");
  assert.equal(ticket.before, "1");
  assert.equal(ticket.after, "2");
  const unknown = proof("acme.future", "thing", "done");
  assert.ok(unknown.summary.includes("thing"));
  const images = proof("creative.campaign_image", "Black Friday", "done", {}, {
    images: ["https://img/1.png", "https://img/2.png"],
    image: { url: "https://img/2.png", boxes: [{ label: "code", box: [1, 2, 3, 4], ok: true }] },
    visionSummary: "Checked by Muse Spark",
  });
  assert.equal(images.summary, "Made 2 campaign images");
  assert.equal(images.image.url, "https://img/2.png");
  assert.equal(images.image.boxes.length, 1);
  assert.equal(images.visionSummary, "Checked by Muse Spark");
});
