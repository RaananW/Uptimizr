// @vitest-environment node
/**
 * Sanity test for the engine-side `.jslib` shim (`bridge/Uptimizr.jslib`).
 *
 * Unity compiles `.jslib` files with Emscripten: `mergeInto(LibraryManager.library, …)`
 * registers each entry as a C-callable export, `$Name` entries become plain JS
 * objects (`var Name = …`) that the exports reference as free variables, and `__deps`
 * declarations tell the linker which of those objects to keep. A missing `__deps`
 * entry is a **silent** failure — the export links, then throws `ReferenceError` at
 * runtime inside the WebGL build, long after any JS test could catch it.
 *
 * Unity itself is not available in CI, so this is the cheap pre-check (#253): load
 * the shim as text, evaluate it in a `node:vm` sandbox with mocked Emscripten globals,
 * resolve the `$UptimizrUnityBridge` dependency the way Emscripten does, and assert
 * every export forwards correctly to a fake `window.__uptimizr_unity__` bridge. The
 * real end-to-end check (a built WebGL export driven by Playwright) lives in
 * `examples/playground/e2e/unity-export.spec.ts` against `examples/unity-web-export/`.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const BRIDGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../bridge");
const JSLIB_PATH = resolve(BRIDGE_DIR, "Uptimizr.jslib");
const CSHARP_PATH = resolve(BRIDGE_DIR, "UptimizrUnityBridge.cs");

/** The C-callable exports the shim must register (mirrors the C# `DllImport`s). */
const EXPORTS = [
  "UptimizrUnityGetProtocolVersion",
  "UptimizrUnityPushPose",
  "UptimizrUnityPushPick",
  "UptimizrUnityPushPerf",
  "UptimizrUnitySetSceneProxy",
] as const;

type Export = (typeof EXPORTS)[number];
type PluginFn = (...args: number[]) => unknown;
type Plugin = Record<string, unknown>;

/** A fake `EngineBridge` recording every call the shim forwards. */
function fakeBridge(protocolVersion: unknown = 1) {
  return {
    protocolVersion,
    pushPose: vi.fn(),
    pushPick: vi.fn(),
    pushPerf: vi.fn(),
    setSceneProxy: vi.fn(),
  };
}

interface Sandbox {
  /** The object handed to `mergeInto` — the plugin as Emscripten sees it. */
  plugin: Plugin;
  /** The mocked `window`; set `__uptimizr_unity__` to attach / detach a bridge. */
  window: { __uptimizr_unity__?: unknown };
  /** Allocate a fake UTF-8 string "pointer" that the mocked `UTF8ToString` decodes. */
  alloc(text: string): number;
  /** Call a C-callable export by name. */
  call(name: Export, ...args: number[]): unknown;
}

/**
 * Evaluate the shim in an isolated sandbox with mocked Emscripten globals. Pass
 * `withWindow: false` to simulate an environment without a `window` (a worker).
 */
function loadJslib(options: { bridge?: unknown; withWindow?: boolean } = {}): Sandbox {
  const source = readFileSync(JSLIB_PATH, "utf8");
  const strings = new Map<number, string>();
  let nextPtr = 1024;
  const win: Sandbox["window"] = {};
  if (options.bridge !== undefined) win.__uptimizr_unity__ = options.bridge;

  let captured: Plugin | undefined;
  const globals: Record<string, unknown> = {
    LibraryManager: { library: {} },
    mergeInto(target: Plugin, src: Plugin) {
      Object.assign(target, src);
      captured = src;
    },
    // Emscripten's heap string decoder; `0` (NULL) decodes to "" like the real one.
    UTF8ToString(ptr: number) {
      return strings.get(ptr) ?? "";
    },
  };
  if (options.withWindow !== false) globals.window = win;

  const context = createContext(globals);
  runInContext(source, context, { filename: "Uptimizr.jslib" });
  if (!captured) throw new Error("the .jslib never called mergeInto(LibraryManager.library, …)");

  // Emscripten emits every `$Name` library object as `var Name = …` in the output
  // module, so exports declared `__deps: ["$Name"]` reference it as a free variable.
  // Mirror that by hoisting each `$`-prefixed object onto the sandbox global.
  for (const key of Object.keys(captured)) {
    if (key.startsWith("$") && !key.endsWith("__deps")) {
      context[key.slice(1)] = captured[key];
    }
  }

  const plugin = captured;
  return {
    plugin,
    window: win,
    alloc(text) {
      const ptr = nextPtr;
      nextPtr += 64;
      strings.set(ptr, text);
      return ptr;
    },
    call(name, ...args) {
      const fn = plugin[name];
      if (typeof fn !== "function") throw new Error(`${name} is not a function export`);
      return (fn as PluginFn)(...args);
    },
  };
}

describe("bridge/Uptimizr.jslib (engine-side shim)", () => {
  describe("shape (what Emscripten links)", () => {
    it("registers every C-callable export as a function", () => {
      const { plugin } = loadJslib();
      for (const name of EXPORTS) {
        expect(typeof plugin[name], `${name} should be a function`).toBe("function");
      }
    });

    it("registers only the documented exports (no stray keys that would link as symbols)", () => {
      const { plugin } = loadJslib();
      const keys = Object.keys(plugin).filter((k) => !k.endsWith("__deps") && !k.startsWith("$"));
      expect(keys.sort()).toEqual([...EXPORTS].sort());
    });

    it("exposes the $UptimizrUnityBridge library object with a get() resolver", () => {
      const { plugin } = loadJslib();
      const dep = plugin.$UptimizrUnityBridge as { get?: unknown } | undefined;
      expect(typeof dep?.get).toBe("function");
      expect(Array.isArray(plugin.$UptimizrUnityBridge__deps)).toBe(true);
    });

    it("declares the $UptimizrUnityBridge dependency on every export (a missing dep is a silent link-time drop)", () => {
      const { plugin } = loadJslib();
      for (const name of EXPORTS) {
        const deps = plugin[`${name}__deps`];
        expect(Array.isArray(deps), `${name}__deps should be declared`).toBe(true);
        expect(deps, `${name}__deps should include $UptimizrUnityBridge`).toContain(
          "$UptimizrUnityBridge",
        );
      }
    });

    it("matches the [DllImport] declarations in the companion MonoBehaviour", () => {
      const cs = readFileSync(CSHARP_PATH, "utf8");
      const declared = [...cs.matchAll(/static extern \w+ (UptimizrUnity\w+)\s*\(/g)].map(
        (m) => m[1],
      );
      expect(declared.sort()).toEqual([...EXPORTS].sort());
    });
  });

  describe("UptimizrUnityGetProtocolVersion", () => {
    it("returns the bridge's protocolVersion", () => {
      const sb = loadJslib({ bridge: fakeBridge(1) });
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(1);
    });

    it("returns -1 when the connector has not attached a bridge", () => {
      const sb = loadJslib();
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(-1);
    });

    it("returns -1 when the attached object has no numeric protocolVersion", () => {
      const sb = loadJslib({ bridge: fakeBridge("1") });
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(-1);
    });

    it("resolves the bridge lazily on every call (connector may attach after the export boots)", () => {
      const sb = loadJslib();
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(-1);
      sb.window.__uptimizr_unity__ = fakeBridge(1);
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(1);
      delete sb.window.__uptimizr_unity__;
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(-1);
    });

    it("does not throw when `window` is undefined (worker / non-browser host)", () => {
      const sb = loadJslib({ withWindow: false });
      expect(sb.call("UptimizrUnityGetProtocolVersion")).toBe(-1);
      expect(() => sb.call("UptimizrUnityPushPerf", 60, 0)).not.toThrow();
    });
  });

  describe("UptimizrUnityPushPose", () => {
    it("forwards position / forward / up as arrays plus the fov", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPose", 1, 2, 3, 0, 0, 1, 0, 1, 0, 1.0472);
      expect(bridge.pushPose).toHaveBeenCalledTimes(1);
      expect(bridge.pushPose).toHaveBeenCalledWith([1, 2, 3], [0, 0, 1], [0, 1, 0], 1.0472);
    });

    it("omits the fov argument entirely when fov < 0", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPose", 1, 2, 3, 0, 0, 1, 0, 1, 0, -1);
      expect(bridge.pushPose.mock.calls[0]).toEqual([
        [1, 2, 3],
        [0, 0, 1],
        [0, 1, 0],
      ]);
    });

    it("passes a zero fov through (0 is a value, not the omit sentinel)", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPose", 0, 0, 0, 0, 0, 1, 0, 1, 0, 0);
      expect(bridge.pushPose.mock.calls[0]).toHaveLength(4);
      expect(bridge.pushPose.mock.calls[0][3]).toBe(0);
    });

    it("is a no-op without a bridge", () => {
      const sb = loadJslib();
      expect(() => sb.call("UptimizrUnityPushPose", 1, 2, 3, 0, 0, 1, 0, 1, 0, 1)).not.toThrow();
    });
  });

  describe("UptimizrUnityPushPick", () => {
    it("decodes the UTF-8 name pointer and forwards the world hit point", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      const ptr = sb.alloc("CenterCube");
      sb.call("UptimizrUnityPushPick", ptr, 0.5, 1, -0.5);
      expect(bridge.pushPick).toHaveBeenCalledWith("CenterCube", [0.5, 1, -0.5]);
    });

    it("drops picks with an empty name", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPick", sb.alloc(""), 0, 0, 0);
      sb.call("UptimizrUnityPushPick", 0 /* NULL */, 0, 0, 0);
      expect(bridge.pushPick).not.toHaveBeenCalled();
    });

    it("is a no-op without a bridge", () => {
      const sb = loadJslib();
      expect(() => sb.call("UptimizrUnityPushPick", sb.alloc("x"), 0, 0, 0)).not.toThrow();
    });
  });

  describe("UptimizrUnityPushPerf", () => {
    it("forwards fps and longFrames", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPerf", 59.5, 2);
      expect(bridge.pushPerf).toHaveBeenCalledWith(59.5, 2);
    });

    it("omits longFrames when < 0", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPerf", 60, -1);
      expect(bridge.pushPerf.mock.calls[0]).toEqual([60]);
    });

    it("passes a zero longFrames through (0 is a count, not the omit sentinel)", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnityPushPerf", 60, 0);
      expect(bridge.pushPerf.mock.calls[0]).toEqual([60, 0]);
    });

    it("is a no-op without a bridge", () => {
      const sb = loadJslib();
      expect(() => sb.call("UptimizrUnityPushPerf", 60, 0)).not.toThrow();
    });
  });

  describe("UptimizrUnitySetSceneProxy", () => {
    const nodes = [
      { name: "CenterCube", aabb: [-0.5, 0.5, -0.5, 0.5, 1.5, 0.5] },
      { name: "LeftCube", aabb: [-3, 0.5, -0.5, -2, 1.5, 0.5] },
    ];

    it("parses the JSON node list and forwards it", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnitySetSceneProxy", sb.alloc(JSON.stringify(nodes)));
      expect(bridge.setSceneProxy).toHaveBeenCalledWith(nodes);
    });

    it("ignores invalid JSON instead of throwing across the interop boundary", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      expect(() =>
        sb.call("UptimizrUnitySetSceneProxy", sb.alloc('[{"name": "broken"')),
      ).not.toThrow();
      expect(bridge.setSceneProxy).not.toHaveBeenCalled();
    });

    it("ignores valid JSON that is not an array", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnitySetSceneProxy", sb.alloc(JSON.stringify({ name: "x" })));
      sb.call("UptimizrUnitySetSceneProxy", sb.alloc("42"));
      sb.call("UptimizrUnitySetSceneProxy", sb.alloc("null"));
      expect(bridge.setSceneProxy).not.toHaveBeenCalled();
    });

    it("ignores an empty / NULL string", () => {
      const bridge = fakeBridge();
      const sb = loadJslib({ bridge });
      sb.call("UptimizrUnitySetSceneProxy", sb.alloc(""));
      sb.call("UptimizrUnitySetSceneProxy", 0);
      expect(bridge.setSceneProxy).not.toHaveBeenCalled();
    });

    it("is a no-op without a bridge", () => {
      const sb = loadJslib();
      expect(() =>
        sb.call("UptimizrUnitySetSceneProxy", sb.alloc(JSON.stringify(nodes))),
      ).not.toThrow();
    });
  });
});
