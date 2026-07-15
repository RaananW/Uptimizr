import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guards the ADR 0047 / ADR 0050 code-split boundary at the dashboard level: the
// dashboard's client entry (`app/page.tsx`) must never *statically* reach the
// opt-in assistant surface or its heavy LLM dependencies. `<AssistantPanel>` is
// pulled only through a lazy `import("@uptimizr/react/assistant")` inside
// `components/AssistantDrawer.tsx`, and `@mlc-ai/web-llm` stays behind a further
// `import()` inside agent-core — so a user who never opens the assistant loads
// zero assistant/LLM code in the main bundle. This mirrors the react package's
// `entryPurity.test.ts`, but walks the dashboard's own source graph (resolving
// both relative and the `@/*` alias) so it holds without a built bundle.

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..");
const srcRoot = resolve(appRoot, "..");

// Only static `import`/`export ... from` edges count. Dynamic `import()` is the
// code-split seam and is deliberately ignored.
const STATIC_EDGE =
  /(?:^|[^.\w])(?:import|export)\b[^;]*?\bfrom\s*["'`]([^"'`]+)["'`]|(?:^|[^.\w])import\s*["'`]([^"'`]+)["'`]/g;

function resolveModule(fromFile: string, spec: string): string | null {
  // Local specifier: relative, or the `@/*` -> `src/*` alias.
  let base: string | null = null;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = resolve(srcRoot, spec.slice(2));
  if (!base) return null;
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return (
    candidates.find((c) => (c.endsWith(".ts") || c.endsWith(".tsx") ? existsSync(c) : false)) ??
    null
  );
}

function isLocal(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("@/");
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
      if (isLocal(spec)) {
        const resolved = resolveModule(file, spec);
        if (resolved) stack.push(resolved);
      } else {
        bare.add(spec);
      }
    }
  }
  return { files, bare };
}

describe("dashboard `page.tsx` entry purity (ADR 0047 / ADR 0050)", () => {
  const { bare } = collect(resolve(appRoot, "page.tsx"));

  it("does not statically pull the assistant subpath, agent-core, or the WebLLM runtime", () => {
    const forbidden = [...bare].filter(
      (s) =>
        s === "@mlc-ai/web-llm" ||
        s === "@uptimizr/react/assistant" ||
        s.startsWith("@uptimizr/agent-core"),
    );
    expect(forbidden).toEqual([]);
  });
});
