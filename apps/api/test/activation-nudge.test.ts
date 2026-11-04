import { describe, expect, it, vi } from "vitest";
import {
  ACTIVATION_BASELINE_PCT,
  ACTIVATION_TARGET_PCT,
  createRazorEmail,
  createRazorWorkflow,
  previewUrlForEmail,
  shipRazorActivationNudge,
} from "../src/activation-nudge.js";
import { providerFetch } from "../src/integrations/http.js";

vi.mock("../src/integrations/http.js", () => ({
  providerFetch: vi.fn(),
}));

const input = {
  subject: "Finish setup in 2 minutes",
  fromName: "Muse",
  replyTo: "hello@example.com",
  htmlBody: "<p>Pick up where you left off.</p>",
  ctaText: "Continue setup",
  ctaUrl: "https://example.com/activate",
};

describe("razor activation nudge", () => {
  it("ties to 32 to 37", () => {
    expect(ACTIVATION_BASELINE_PCT).toBe(32);
    expect(ACTIVATION_TARGET_PCT).toBe(37);
  });

  it("ships 1 email + 1 ACTIVE workflow with preview", async () => {
    const mocked = providerFetch as unknown as ReturnType<typeof vi.fn>;
    mocked.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "email-1" }),
    });
    mocked.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "flow-1" }),
    });
    const out = await shipRazorActivationNudge("tok", input);
    expect(out.emailId).toBe("email-1");
    expect(out.workflowId).toBe("flow-1");
    expect(out.workflowStatus).toBe("ACTIVE");
    expect(out.previewUrl).toBe(previewUrlForEmail("email-1"));
    expect(mocked).toHaveBeenCalledTimes(2);
    const emailCall = mocked.mock.calls[0];
    expect(String(emailCall[1])).toContain("/marketing/v3/emails");
    const flowCall = mocked.mock.calls[1];
    expect(String(flowCall[1])).toContain("/automation/v4/flows");
    const flowBody = JSON.parse(String(flowCall[2].body));
    expect(flowBody.status).toBe("ACTIVE");
    expect(flowBody.actions).toHaveLength(1);
  });

  it("creates single-send email and workflow", async () => {
    const mocked = providerFetch as unknown as ReturnType<typeof vi.fn>;
    mocked.mockReset();
    mocked.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "e9" }),
    });
    const e = await createRazorEmail("tok", input);
    expect(e.emailId).toBe("e9");
    mocked.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "w9" }),
    });
    const w = await createRazorWorkflow("tok", "e9");
    expect(w.workflowId).toBe("w9");
  });
});
