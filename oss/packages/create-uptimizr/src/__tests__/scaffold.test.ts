import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scaffold } from "../scaffold.js";
import { ENGINES } from "../templates.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "create-uptimizr-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scaffold", () => {
  it("writes the expected files for the default (babylon) engine", () => {
    const dir = join(root, "my-analytics");
    const res = scaffold({ targetDir: dir, engine: "babylon" });

    const entries = readdirSync(dir).sort();
    expect(entries).toEqual([
      ".env",
      ".gitignore",
      "README.md",
      "client-snippet.babylon.ts",
      "data",
      "package.json",
    ]);
    expect(res.folderName).toBe("my-analytics");
    expect(res.projectName).toBe("my-analytics");
  });

  it("generates a strong, unique visitor-hash secret in .env", () => {
    const a = scaffold({ targetDir: join(root, "a"), engine: "babylon" });
    const b = scaffold({ targetDir: join(root, "b"), engine: "babylon" });
    const secretOf = (d: string) =>
      /^VISITOR_HASH_SECRET=([0-9a-f]{64})$/m.exec(readFileSync(join(d, ".env"), "utf8"))?.[1];
    const sa = secretOf(a.dir);
    const sb = secretOf(b.dir);
    expect(sa).toMatch(/^[0-9a-f]{64}$/);
    expect(sb).toMatch(/^[0-9a-f]{64}$/);
    expect(sa).not.toBe(sb);
  });

  it("wires package.json scripts to the uptimizr CLI", () => {
    const { dir } = scaffold({
      targetDir: join(root, "p"),
      engine: "three",
      projectName: "My Game",
    });
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts.setup).toBe('uptimizr init "My Game"');
    expect(pkg.scripts.start).toBe("uptimizr serve");
    expect(pkg.dependencies["@uptimizr/collector-server"]).toBeDefined();
  });

  it("emits a correct client snippet per engine", () => {
    const expectations: Record<string, string> = {
      babylon: "trackScene(scene, {",
      "babylon-lite": "trackScene(scene, camera, canvas, {",
      three: "trackScene(scene, camera, renderer, {",
      playcanvas: "trackScene(app, cameraEntity, {",
      r3f: "<Uptimizr projectId=",
      aframe: 'uptimizr="projectId:',
    };
    for (const engine of ENGINES) {
      const dir = join(root, engine);
      scaffold({ targetDir: dir, engine });
      const snippet = readFileSync(join(dir, `client-snippet.${engine}.ts`), "utf8");
      expect(snippet, engine).toContain(expectations[engine]);
    }
  });

  it("bakes a custom port into .env and the snippet", () => {
    const { dir } = scaffold({ targetDir: join(root, "port"), engine: "babylon", port: 5000 });
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("COLLECTOR_PORT=5000");
    expect(readFileSync(join(dir, "client-snippet.babylon.ts"), "utf8")).toContain(
      "http://localhost:5000",
    );
  });

  it("refuses to scaffold into a non-empty directory", () => {
    const dir = join(root, "taken");
    scaffold({ targetDir: dir, engine: "babylon" });
    writeFileSync(join(dir, "extra.txt"), "x");
    expect(() => scaffold({ targetDir: dir, engine: "babylon" })).toThrow(/not empty/);
  });

  it("omits dashboard and demo by default (collector only)", () => {
    const { dir, withDashboard, withDemo } = scaffold({
      targetDir: join(root, "minimal"),
      engine: "babylon",
    });
    expect(withDashboard).toBe(false);
    expect(withDemo).toBe(false);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@uptimizr/dashboard"]).toBeUndefined();
    expect(pkg.scripts.dashboard).toBeUndefined();
    expect(pkg.scripts.demo).toBeUndefined();
    expect(readdirSync(dir)).not.toContain("demo");
  });

  it("adds the dashboard dependency, script, and CORS origin when requested", () => {
    const { dir, withDashboard } = scaffold({
      targetDir: join(root, "dash"),
      engine: "babylon",
      withDashboard: true,
    });
    expect(withDashboard).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@uptimizr/dashboard"]).toBeDefined();
    expect(pkg.scripts.dashboard).toContain("uptimizr-dashboard");
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("http://localhost:3000");
  });

  it("writes a runnable demo scene and script when requested", () => {
    const { dir, withDemo } = scaffold({
      targetDir: join(root, "demo"),
      engine: "babylon",
      withDemo: true,
    });
    expect(withDemo).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.scripts.demo).toBe("node demo/serve.mjs");
    const html = readFileSync(join(dir, "demo", "index.html"), "utf8");
    expect(html).toContain("@uptimizr/babylon");
    expect(html).toContain("trackScene(scene");
    expect(html).toContain("http://localhost:4318");
    const server = readFileSync(join(dir, "demo", "serve.mjs"), "utf8");
    expect(server).toContain("createServer");
  });
});
