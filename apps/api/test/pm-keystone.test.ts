import { describe, expect, it } from "vitest";
import {
  buildPmKeystoneDescription,
  PM_KEYSTONE_TITLE,
  validatePmKeystoneReady,
} from "../src/pm-keystone.js";

describe("pm keystone razor issue", () => {
  it("has razor title with baseline and target", () => {
    expect(PM_KEYSTONE_TITLE).toContain("Activation");
    expect(PM_KEYSTONE_TITLE).toContain("32%");
    expect(PM_KEYSTONE_TITLE).toContain("37%");
  });

  it("passes ready gate: problem, baseline/target, scope, 3 AC, size", () => {
    const body = buildPmKeystoneDescription();
    expect(body).toContain("## Problem");
    expect(body).toContain("32%");
    expect(body).toContain("37%");
    expect(body).toContain("## In scope");
    expect(body).toContain("## Out of scope");
    expect(body).toContain("AC1");
    expect(body).toContain("AC2");
    expect(body).toContain("AC3");
    expect(body).toContain("## Size (async)");
    expect(body).toContain("## Ready");
    expect(validatePmKeystoneReady(PM_KEYSTONE_TITLE, body)).toEqual([]);
  });

  it("explicitly rejects proxies and over-scope", () => {
    const body = buildPmKeystoneDescription();
    expect(body).toContain("No Zendesk / HubSpot proxies");
    expect(body).toContain("No 5-artifact analyst pack");
    expect(body).toContain("No lib/keystone.py guard");
  });
});
