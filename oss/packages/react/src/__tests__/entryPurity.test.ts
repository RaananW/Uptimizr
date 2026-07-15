import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the ADR 0047 / ADR 0050 code-split boundary: the main `.` entry
// (`src/index.ts`) must never *statically* reach the opt-in assistant surface
// or its heavy LLM dependencies. Anything under `src/assistant/**` is only
// reachable through the `@uptimizr/react/assistant` subpath and, from there,
// through `import()`-ed provider subpaths — so a consumer importing only the
// existing panels pulls zero assistant/LLM code. This mirrors the import-graph
// check #191 ran on `@uptimizr/agent-core`, but over the deterministic source
// graph so it holds even when `dist/` has not been built yet.

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");

// Only static `import`/`export ... from` edges count. Dynamic `import()` is the
// code-split seam and is deliberately ignored.
const STATIC_EDGE =
  /(?:^|[^.\w])(?:import|export)\b[^;]*?\bfrom\s*["'`]([^"'`]+)["'`]|(?:^|[^.\w])import\s*["'`]([^"'`]+)["'`]/g;

function resolveModule(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return (
    candidates.find((c) => (c.endsWith(".ts") || c.endsWith(".tsx") ? existsSync(c) : false)) ??
    null
  );
}

function collect(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (files.has(file) || !existsSync(file)) continue;
    files.add(file);
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(STATIC_EDGE)) {
      const spec = match[1] ?? match[2];
      if (!spec) continue;
      if (spec.startsWith(".")) {
        const resolved = resolveModule(file, spec);
        if (resolved) stack.push(resolved);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files, bare };
}

describe("`.` entry purity (ADR 0047 / ADR 0050)", () => {
  const { files, bare } = collect(resolve(srcRoot, "index.ts"));

  it("does not statically reach any assistant module", () => {
    const leaked = [...files].filter((f) => f.includes(`${srcRoot}/assistant/`));
    expect(leaked).toEqual([]);
  });

  it("does not statically pull agent-core or the WebLLM runtime", () => {
    const forbidden = [...bare].filter(
      (s) => s === "@mlc-ai/web-llm" || s.startsWith("@uptimizr/agent-core"),
    );
    expect(forbidden).toEqual([]);
  });
});
