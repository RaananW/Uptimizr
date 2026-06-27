import { describe, expect, it } from "vitest";
import { parseClientInfo } from "../userAgent.js";

describe("parseClientInfo", () => {
  it("returns Other/Other for a missing or empty User-Agent", () => {
    expect(parseClientInfo(undefined)).toEqual({ browser: "Other", os: "Other" });
    expect(parseClientInfo("")).toEqual({ browser: "Other", os: "Other" });
  });

  it("parses Chrome on Windows", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(parseClientInfo(ua)).toEqual({ browser: "Chrome", os: "Windows" });
  });

  it("parses Safari on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15";
    expect(parseClientInfo(ua)).toEqual({ browser: "Safari", os: "macOS" });
  });

  it("parses Safari on iOS (iPhone)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
    expect(parseClientInfo(ua)).toEqual({ browser: "Safari", os: "iOS" });
  });

  it("parses Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(parseClientInfo(ua)).toEqual({ browser: "Chrome", os: "Android" });
  });

  it("parses Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
    expect(parseClientInfo(ua)).toEqual({ browser: "Firefox", os: "Linux" });
  });

  it("distinguishes Edge from Chrome", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(parseClientInfo(ua).browser).toBe("Edge");
  });

  it("distinguishes Opera from Chrome", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0";
    expect(parseClientInfo(ua).browser).toBe("Opera");
  });

  it("parses Chrome on Chrome OS", () => {
    const ua =
      "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    expect(parseClientInfo(ua)).toEqual({ browser: "Chrome", os: "ChromeOS" });
  });

  it("never echoes the raw User-Agent or a version", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const { browser, os } = parseClientInfo(ua);
    expect(`${browser}${os}`).not.toMatch(/120|537|Mozilla|NT 10/);
  });
});
