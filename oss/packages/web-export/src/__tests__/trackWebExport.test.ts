import { describe, expect, it } from "vitest";
import type { AnyEvent } from "@uptimizr/schema";
import type { Transport } from "@uptimizr/sdk-core";
import { trackWebExport } from "../trackWebExport.js";

/** A transport that records every delivered event. */
function recordingTransport(): { transport: Transport; sent: AnyEvent[] } {
  const sent: AnyEvent[] = [];
  return {
    sent,
    transport: {
      send: async (batch) => {
        sent.push(...batch.events);
        return true;
      },
    },
  };
}

describe("trackWebExport", () => {
  it("runs beforeSend on captured errors, so they can be redacted", async () => {
    const { transport, sent } = recordingTransport();
    const { client } = trackWebExport({
      projectId: "p1",
      endpoint: "https://collect.example.com",
      name: "unity",
      frame: { handedness: "left", upAxis: "y", unitScale: 1 },
      bridgeGlobal: false,
      flushIntervalMs: 0,
      capture: { pointerMove: false, clicks: false, perf: false, errors: true },
      transport,
      beforeSend: (event) =>
        event.type === "runtime_error" ? { ...event, message: "[redacted]" } : event,
    });

    dispatchEvent(Object.assign(new Event("error"), { message: "user@example.com failed" }));
    await client.flush();

    const error = sent.find((event) => event.type === "runtime_error");
    expect(error).toMatchObject({ type: "runtime_error", message: "[redacted]" });
    await client.stop("manual");
  });
});
