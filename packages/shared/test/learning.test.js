import test from "node:test";
import assert from "node:assert/strict";
import {
  isPlaybookStatus,
  isThumb,
  playbookBlock,
  saneTactics,
} from "../src/learning.ts";

test("thumbs and statuses validate", () => {
  assert.equal(isThumb("up"), true);
  assert.equal(isThumb("down"), true);
  assert.equal(isThumb("meh"), false);
  assert.equal(isPlaybookStatus("draft"), true);
  assert.equal(isPlaybookStatus("approved"), true);
  assert.equal(isPlaybookStatus("vetoed"), true);
  assert.equal(isPlaybookStatus("archived"), false);
});

test("tactics sanitize system, length, and count", () => {
  const out = saneTactics(
    [
      { system: "slack", tactic: "Keep announcements under 40 words" },
      { system: "email", tactic: "Send more email blasts weekly" },
      { system: "github", tactic: "short" },
      { system: "github", tactic: "  " },
      null,
      "nope",
    ],
    2,
  );
  assert.deepEqual(out, [
    { system: "slack", tactic: "Keep announcements under 40 words" },
    { system: "general", tactic: "Send more email blasts weekly" },
  ]);
  assert.deepEqual(saneTactics("nope"), []);
});

test("playbook block sorts for replay safety", () => {
  assert.equal(playbookBlock([]), "Playbook: (none yet)");
  const a = playbookBlock(["zebra tactic here", "apple tactic here"]);
  const b = playbookBlock(["apple tactic here", "zebra tactic here"]);
  assert.equal(a, b);
  assert.match(a, /\[1\] apple tactic here/);
});
