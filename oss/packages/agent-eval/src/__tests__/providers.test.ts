import { describe, expect, it } from "vitest";
import { readTools } from "@uptimizr/agent-core";
import {
  createHostedProviderFromEnv,
  describeHosted,
  hostedApiFrom,
  hostedKeyAvailable,
  type Env,
} from "../providers/index.js";
import { createScriptedProvider, scriptedArgsFor } from "../providers/scripted.js";
import { EVAL_RANGE } from "../fixtures.js";
import type { EvalCase } from "../cases.js";

const byName = new Map(readTools.map((tool) => [tool.name, tool]));

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "demo",
    category: "performance",
    question: "How is frame rate?",
    file: "performance.yaml",
    context: {},
    capability: "query",
    expectedTools: [["perf_summary"]],
    expectedArgs: {},
    expectedAnswer: { numbers: [], phrases: [], forbiddenPhrases: [] },
    ...overrides,
  };
}

describe("hosted provider configuration", () => {
  it("defaults to Anthropic and claude-sonnet-5", () => {
    const env: Env = {};
    expect(hostedApiFrom(env)).toBe("anthropic");
    expect(describeHosted(env)).toEqual({
      api: "anthropic",
      model: "claude-sonnet-5",
      endpoint: "https://api.anthropic.com/v1",
    });
  });

  it("honours the eval-specific overrides", () => {
    const env: Env = {
      UPTIMIZR_EVAL_PROVIDER: "openai",
      UPTIMIZR_EVAL_MODEL: "some-model",
      UPTIMIZR_EVAL_ENDPOINT: "https://gateway.example.com/v1",
    };
    expect(describeHosted(env)).toEqual({
      api: "openai",
      model: "some-model",
      endpoint: "https://gateway.example.com/v1",
    });
  });

  it("finds a key in either the eval variable or the provider's own", () => {
    expect(hostedKeyAvailable({})).toBe(false);
    expect(hostedKeyAvailable({ UPTIMIZR_EVAL_API_KEY: "   " })).toBe(false);
    expect(hostedKeyAvailable({ UPTIMIZR_EVAL_API_KEY: "k" })).toBe(true);
    expect(hostedKeyAvailable({ ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(hostedKeyAvailable({ OPENAI_API_KEY: "k" })).toBe(false);
    expect(hostedKeyAvailable({ UPTIMIZR_EVAL_PROVIDER: "openai", OPENAI_API_KEY: "k" })).toBe(
      true,
    );
  });

  it("never puts the key in the description or the error", () => {
    const env: Env = { UPTIMIZR_EVAL_API_KEY: "sk-secret-value" };
    expect(JSON.stringify(describeHosted(env))).not.toContain("sk-secret-value");
    let message = "";
    try {
      createHostedProviderFromEnv({});
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("UPTIMIZR_EVAL_API_KEY");
    expect(message).not.toContain("sk-");
  });

  it("builds a provider once a key is present", () => {
    expect(createHostedProviderFromEnv({ UPTIMIZR_EVAL_API_KEY: "k" })).toHaveProperty("complete");
  });
});

describe("scriptedArgsFor", () => {
  it("fills the fixture range for any tool that takes one", () => {
    const args = scriptedArgsFor(makeCase(), byName.get("perf_summary")!);
    expect(args).toMatchObject({ since: EVAL_RANGE.since, until: EVAL_RANGE.until });
  });

  it("maps scene and session context onto both querystring and path arguments", () => {
    const scoped = makeCase({ context: { scene: "lobby", session: "s1" } });
    expect(scriptedArgsFor(scoped, byName.get("perf_by_scene")!)).toMatchObject({
      scene: "lobby",
      session: "s1",
    });
    expect(scriptedArgsFor(scoped, byName.get("session_meta")!)).toMatchObject({ sessionId: "s1" });
    expect(scriptedArgsFor(scoped, byName.get("scene_representation")!)).toMatchObject({
      sceneId: "lobby",
    });
  });

  it("supplies a required argument the case did not state", () => {
    expect(scriptedArgsFor(makeCase(), byName.get("mesh_uv_heatmap")!)).toMatchObject({
      mesh: "box",
    });
  });

  it("lets the case's own expectedArgs win", () => {
    const evalCase = makeCase({ expectedArgs: { mesh_uv_heatmap: { mesh: "sphere" } } });
    expect(scriptedArgsFor(evalCase, byName.get("mesh_uv_heatmap")!)).toMatchObject({
      mesh: "sphere",
    });
  });
});

describe("createScriptedProvider", () => {
  it("asks for one tool per any-of set, then answers from the results", async () => {
    const evalCase = makeCase({
      expectedTools: [["perf_summary", "perf_distribution"], ["jank_rate"]],
    });
    const provider = createScriptedProvider(evalCase, readTools);

    const first = await provider.complete({
      messages: [],
      tools: [{ name: "x", description: "", parameters: {} }],
    });
    expect(first.kind).toBe("tool_calls");
    if (first.kind !== "tool_calls") throw new Error("unreachable");
    expect(first.toolCalls.map((c) => c.name)).toEqual(["perf_summary", "jank_rate"]);

    const second = await provider.complete({
      messages: [
        { role: "tool", toolCallId: "1", name: "perf_summary", content: '[{"avg_fps":42.2}]' },
      ],
      tools: [],
    });
    expect(second.kind).toBe("final");
    expect(second.content).toContain("42.2");
    // The answer must not echo the question — a required phrase has to come from
    // the data, not from the wording of the case.
    expect(second.content).not.toContain(evalCase.question);
  });

  it("fails loudly when a case names a tool outside the catalog", async () => {
    const provider = createScriptedProvider(
      makeCase({ expectedTools: [["not_a_tool"]] }),
      readTools,
    );
    await expect(
      provider.complete({ messages: [], tools: [{ name: "x", description: "", parameters: {} }] }),
    ).rejects.toThrow(/not in the catalog/);
  });
});
