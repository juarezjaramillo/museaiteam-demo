import { describe, expect, it } from "vitest";
import { authRedirectTarget, sessionCookie } from "../src/auth.js";

const APP = "https://museaiteam.pages.dev";
const API = "https://museaiteam-api.juarezjaramillo.workers.dev";

describe("post-auth landing", () => {
  it("sends Auth.js's default same-host target to the app home", () => {
    expect(authRedirectTarget(APP, `${API}/api/auth/signin`)).toBe(APP);
  });

  it("keeps relative and same-app targets", () => {
    expect(authRedirectTarget(APP, "/#/hires")).toBe(`${APP}/#/hires`);
    expect(authRedirectTarget(APP, `${APP}/?connected=github`)).toBe(`${APP}/?connected=github`);
  });

  it("rejects off-app and malformed targets", () => {
    expect(authRedirectTarget(APP, "https://evil.test/phish")).toBe(APP);
    expect(authRedirectTarget(APP, "https://[broken")).toBe(APP);
  });
});

describe("session cookie", () => {
  it("is cross-site Secure on https so Pages calls stay logged in", () => {
    expect(sessionCookie(APP)).toEqual({
      name: "__Secure-authjs.session-token",
      options: { httpOnly: true, sameSite: "none", path: "/", secure: true },
    });
  });

  it("stays Lax on local http where Secure cannot set", () => {
    expect(sessionCookie("http://localhost:5173")).toEqual({
      name: "authjs.session-token",
      options: { httpOnly: true, sameSite: "lax", path: "/", secure: false },
    });
  });
});
