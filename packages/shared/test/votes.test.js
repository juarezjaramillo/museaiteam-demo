import test from "node:test";
import assert from "node:assert/strict";
import { normalizeVoteMatrix } from "../src/votes.ts";

const proposals = [{ id: "p1" }, { id: "p2" }];

test("full ballots pass through untouched", () => {
  const out = normalizeVoteMatrix(proposals, [
    {
      role: "pm",
      votes: [
        { proposalId: "p1", choice: "for", reason: "yes" },
        { proposalId: "p2", choice: "against", reason: "no" },
      ],
    },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    role: "pm",
    proposalId: "p1",
    choice: "for",
    reason: "yes",
  });
});

test("unknown proposal ids are dropped", () => {
  const out = normalizeVoteMatrix(proposals, [
    {
      role: "pm",
      votes: [
        { proposalId: "p1", choice: "for", reason: "yes" },
        { proposalId: "ghost", choice: "for", reason: "hallucinated" },
      ],
    },
  ]);
  assert.ok(out.every((v) => v.proposalId !== "ghost"));
  assert.equal(out.length, 2); // p1 vote + p2 abstain-fill
});

test("duplicate votes keep the first", () => {
  const out = normalizeVoteMatrix([{ id: "p1" }], [
    {
      role: "pm",
      votes: [
        { proposalId: "p1", choice: "for", reason: "first" },
        { proposalId: "p1", choice: "against", reason: "second" },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].choice, "for");
});

test("missing votes become explicit abstentions", () => {
  const out = normalizeVoteMatrix(proposals, [{ role: "pm", votes: [] }]);
  assert.equal(out.length, 2);
  assert.ok(out.every((v) => v.choice === "abstain"));
});

test("matrix is always roles × proposals", () => {
  const out = normalizeVoteMatrix(proposals, [
    { role: "a", votes: [] },
    { role: "b", votes: [] },
    { role: "c", votes: [] },
  ]);
  assert.equal(out.length, 6);
});
