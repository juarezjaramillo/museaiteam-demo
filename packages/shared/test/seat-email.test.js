import test from "node:test";
import assert from "node:assert/strict";
import { HIRES_DOMAIN, parseHireAddress, seatEmail } from "../src/seat-email.ts";

test("derives stable hire addresses", () => {
  assert.equal(seatEmail("analyst", "abc123-def"), `analyst-abc123@${HIRES_DOMAIN}`);
  assert.equal(seatEmail("support", "zzz"), `support-zzz@${HIRES_DOMAIN}`);
});

test("parses hire addresses from To lists", () => {
  assert.equal(
    parseHireAddress(["Priya <analyst-abc123@hires.museaiteam.com>"]),
    "analyst-abc123@hires.museaiteam.com",
  );
  assert.equal(parseHireAddress(["a@x.com", `b@${HIRES_DOMAIN}`]), `b@${HIRES_DOMAIN}`);
  assert.equal(parseHireAddress(["a@x.com"]), null);
});
