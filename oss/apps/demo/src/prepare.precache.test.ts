import { describe, expect, it } from "vitest";
import { precacheUrls } from "./prepare.js";
import { DUCKDB_ASSET_URLS } from "./store/db.js";

// ADR 0050 §6 guard: the one-time "Prepare demo" precache primes only the app
// shell + the embedded surfaces + the heavy DuckDB-Wasm engine assets. The
// in-browser assistant ships inside the embedded dashboard, but its code chunk,
// the `@mlc-ai/web-llm` runtime, and any model weights must stay strictly
// on-demand — a visitor who never opens the assistant downloads nothing extra.
describe("demo precache excludes the assistant (ADR 0050 §6)", () => {
  const urls = precacheUrls();

  it("precaches only the app shell, embeds, and DuckDB-Wasm engine assets", () => {
    expect(urls).toEqual([
      "/",
      "/index.html",
      "/playground/index.html",
      "/dashboard/index.html",
      ...DUCKDB_ASSET_URLS,
    ]);
  });

  it("never precaches the WebLLM runtime, an assistant chunk, or model weights", () => {
    const needles = ["web-llm", "mlc", "assistant", "params_shard", "ndarray-cache"];
    for (const url of urls) {
      // Only the asset filename matters; the dev `/@fs/…` prefix reflects the
      // checkout path (which may itself contain any of these words).
      const name = (url.split("?")[0]?.split("/").pop() ?? "").toLowerCase();
      for (const needle of needles) {
        expect(name.includes(needle.toLowerCase()), `${url} must not reference ${needle}`).toBe(
          false,
        );
      }
    }
  });
});
