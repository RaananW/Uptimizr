/**
 * Local-model eval (WebLLM / WebGPU) — **scaffolded, not yet running**.
 *
 * The design sketch asks for the curated local models to be evaluated weekly in
 * a headless browser, because WebLLM needs WebGPU and WebGPU needs a real GPU
 * stack: there is no Node runtime for it, so the model has to run in a page that
 * Playwright drives. The weekly workflow
 * (`.github/workflows/agent-eval-local.yml`) exists and calls this script; the
 * script deliberately reports and exits rather than pretending to measure
 * something it cannot.
 *
 * ## Why it is a stub today
 *
 * `chromium --headless` on a GitHub-hosted `ubuntu-latest` runner exposes no
 * WebGPU adapter: the runners are CPU-only, and Chromium's software fallback
 * (SwiftShader/Dawn) is not enabled for WebGPU in the headless builds Playwright
 * ships. `navigator.gpu` is therefore absent and `CreateWebGPUEngine` fails
 * before a single token is generated — exactly the case
 * `isWebGpuAvailable()` in `@uptimizr/agent-core/providers/config` already
 * guards in the dashboard.
 *
 * ## What finishing it needs
 *
 * 1. A **page harness**: a tiny bundled page that imports
 *    `@uptimizr/agent-core` + `createWebLlmProvider` from
 *    `@uptimizr/agent-core/providers/webllm`, is handed a case's messages, and
 *    posts back the transcript. The package is browser-safe by design and its
 *    `browserSafety.test.ts` keeps it that way, so nothing else has to move.
 * 2. A **collector the page can reach**. The in-process `app.inject()` client
 *    this harness uses is not reachable from a browser context, so the local-model
 *    job has to bind the seeded collector to an ephemeral port
 *    (`app.listen({ port: 0 })`) and point the page's `createCollectorClient` at
 *    it, with the run's key.
 * 3. A **runner with WebGPU**: either a self-hosted runner with a GPU, or a
 *    Chromium launched with `--enable-unsafe-swiftshader --enable-features=Vulkan`
 *    and a model small enough (the curated 4-bit 7–8B records) to finish inside
 *    the job's timeout. Both need measuring before the weekly job is allowed to
 *    fail a build; until then the job runs this script, which reports the gap.
 * 4. A **baseline slot**. `eval/baseline.json` is keyed by provider, so a
 *    `webllm` entry drops in beside `scripted` and `hosted` with its own
 *    tolerance — local models are noisier, so expect a wider one.
 *
 * Small local models should also be given `coreReadTools` rather than the full
 * 69-tool catalog (see `selectReadTools` in `@uptimizr/agent-core`): the whole
 * catalog does not fit an 8 K context window alongside a prompt.
 */

const REASON =
  "The local-model (WebLLM) eval is scaffolded but not yet running: WebGPU is " +
  "unavailable on GitHub-hosted headless runners, so no local model can be loaded. " +
  "See the module comment in scripts/webllm-eval.ts for what finishing it needs.";

console.log(`::notice title=Local-model eval not run::${REASON}`);
console.log(REASON);
