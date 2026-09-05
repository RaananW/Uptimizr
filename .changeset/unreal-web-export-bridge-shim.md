---
"@uptimizr/unreal": patch
---

Ship the Unreal engine-side bridge shim and record the web-target feasibility finding
(ADR 0045, #112).

The spike confirmed that while Epic has **no official UE5 HTML5/WASM target** (deprecated
after UE 4.24) and Pixel Streaming is server-side, real **Emscripten-based, client-side**
Unreal web exports that render into a `<canvas>` and expose the `EM_JS` / `cwrap` interop
seam **do** exist — the community UE4.24–4.27 HTML5 forks and the experimental UE5.1–5.4
WASM+WebGPU toolchain (Wonder Interactive / SimplyStream). The connector is therefore
**best-effort** but the bridge model is implementable today.

`oss/packages/unreal/bridge/` now ships the actual copy-in shim (`Uptimizr.h` +
`Uptimizr.cpp`): EM_JS glue that samples the active `APlayerCameraManager` pose, raycast
picks, and FPS each frame and pushes **raw** Unreal values (left-handed, z-up, centimeters)
over `window.__uptimizr_unreal__`; a `cwrap`-callable `extern "C"` init that **asserts the
bridge protocol version**; and no-op fallbacks outside Emscripten. No public TypeScript
surface change — the connector still owns the single z-up→y-up + cm→m normalization path.
Privacy unchanged (ADR 0003): only poses, FPS, and developer-named objects cross the bridge.
