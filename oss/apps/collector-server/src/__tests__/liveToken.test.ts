import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintLiveToken, verifyLiveToken } from "../liveToken.js";

const SECRET = "live-secret";

describe("live token", () => {
  it("round-trips a project id and its capabilities within its lifetime", () => {
    const { token, expiresAt } = mintLiveToken("p1", ["query", "query:raw"], SECRET, 1_000, 0);
    expect(expiresAt).toBe(1_000);
    expect(verifyLiveToken(token, SECRET, 500)).toEqual({
      projectId: "p1",
      capabilities: ["query", "query:raw"],
    });
  });

  it("rejects an expired token", () => {
    const { token } = mintLiveToken("p1", ["query"], SECRET, 1_000, 0);
    expect(verifyLiveToken(token, SECRET, 1_000)).toBeNull();
    expect(verifyLiveToken(token, SECRET, 5_000)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = mintLiveToken("p1", ["query"], SECRET, 1_000, 0);
    expect(verifyLiveToken(token, "other-secret", 0)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const { token } = mintLiveToken("p1", ["query"], SECRET, 1_000, 0);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ p: "p2", e: 1_000 })).toString("base64url")}.${sig}`;
    expect(verifyLiveToken(forged, SECRET, 0)).toBeNull();
  });

  it("rejects a forged capability escalation (#309)", () => {
    // The capability set is inside the signed payload, so a client cannot widen
    // its own token from `query` to `query:raw`.
    const { token } = mintLiveToken("p1", ["query"], SECRET, 1_000, 0);
    const [, sig] = token.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({ p: "p1", e: 1_000, c: ["query", "query:raw"] }),
    ).toString("base64url")}.${sig}`;
    expect(verifyLiveToken(forged, SECRET, 0)).toBeNull();
  });

  it("treats a pre-#309 token (no capability claim) as a plain reader", () => {
    // Minted by an older collector: `{p, e}` only. It must keep working across
    // an upgrade, but must not imply `query:raw`.
    const payload = Buffer.from(JSON.stringify({ p: "p1", e: 1_000 })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyLiveToken(`${payload}.${sig}`, SECRET, 0)).toEqual({
      projectId: "p1",
      capabilities: ["query"],
    });
  });

  it("rejects malformed tokens", () => {
    expect(verifyLiveToken("", SECRET, 0)).toBeNull();
    expect(verifyLiveToken("no-dot", SECRET, 0)).toBeNull();
    expect(verifyLiveToken(".sig", SECRET, 0)).toBeNull();
    expect(verifyLiveToken("payload.", SECRET, 0)).toBeNull();
  });
});
