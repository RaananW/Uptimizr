import { describe, expect, it } from "vitest";
import { mintLiveToken, verifyLiveToken } from "../liveToken.js";

const SECRET = "live-secret";

describe("live token", () => {
  it("round-trips a project id within its lifetime", () => {
    const { token, expiresAt } = mintLiveToken("p1", SECRET, 1_000, 0);
    expect(expiresAt).toBe(1_000);
    expect(verifyLiveToken(token, SECRET, 500)).toBe("p1");
  });

  it("rejects an expired token", () => {
    const { token } = mintLiveToken("p1", SECRET, 1_000, 0);
    expect(verifyLiveToken(token, SECRET, 1_000)).toBeNull();
    expect(verifyLiveToken(token, SECRET, 5_000)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = mintLiveToken("p1", SECRET, 1_000, 0);
    expect(verifyLiveToken(token, "other-secret", 0)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const { token } = mintLiveToken("p1", SECRET, 1_000, 0);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ p: "p2", e: 1_000 })).toString("base64url")}.${sig}`;
    expect(verifyLiveToken(forged, SECRET, 0)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifyLiveToken("", SECRET, 0)).toBeNull();
    expect(verifyLiveToken("no-dot", SECRET, 0)).toBeNull();
    expect(verifyLiveToken(".sig", SECRET, 0)).toBeNull();
    expect(verifyLiveToken("payload.", SECRET, 0)).toBeNull();
  });
});
