// Uptimizr — Unreal Engine (web export) telemetry bridge shim (copy-in asset).
//
// This is the engine-side half of the `@uptimizr/unreal` connector (ADR 0045). It is a
// thin, dumb Emscripten shim: each frame it reads the active `APlayerCameraManager` pose
// and FPS, and (on demand) a raycast pick, then pushes the RAW values across the JS
// interop boundary to the browser-side connector exposed on `window.__uptimizr_unreal__`.
//
// It carries NO analytics logic, NO identifiers, and NO schema knowledge. It performs NO
// coordinate math: it pushes Unreal's native world-space values (left-handed, z-up,
// centimeters) unchanged. The JS connector owns the single normalization path
// (z-up -> y-up rebase, cm -> m scale) so every engine stays consistent.
//
// Feasibility (ADR 0045 / issue #112): Epic has no official UE5 HTML5/WASM target (it was
// deprecated after UE 4.24) and Pixel Streaming is server-side. This shim therefore targets
// the real, Emscripten-based, client-side web exports that DO exist and render into a
// `<canvas>`: the community UE4.24-4.27 HTML5 forks (ufna/UE-HTML5,
// SpeculativeCoder/UnrealEngine-HTML5-ES3) and the experimental Wonder Interactive /
// SimplyStream UE5.1-5.4 WASM+WebGPU toolchain. All are Emscripten, so the EM_JS / cwrap
// interop this shim relies on is available by construction. Outside Emscripten (e.g. the
// desktop editor) every entry point compiles to a no-op so it is safe to leave wired in.
//
// Privacy (ADR 0003): only low-cardinality, non-PII telemetry crosses the bridge — poses,
// FPS, and developer-assigned object names. The shim MUST NOT invent identifiers or forward
// raw input text.

#pragma once

#include "CoreMinimal.h"

class UWorld;

/**
 * Wire-protocol version this shim was authored against. It MUST match the JS connector's
 * `BRIDGE_PROTOCOL_VERSION` (see `@uptimizr/web-export`). `FUptimizrTelemetry::Initialize`
 * asserts the live bridge reports the same value before pushing anything.
 */
#define UPTIMIZR_BRIDGE_PROTOCOL_VERSION 1

/**
 * Per-frame telemetry sampler for an Unreal web export. Construct one (or use the global
 * accessed by the `extern "C"` entry points below), `Initialize()` once the export's host
 * page and the `@uptimizr/unreal` connector are up, then call `Tick()` every frame from any
 * actor/component tick. Push picks from your own click/interaction handler via `ReportPick`
 * or the convenience `TraceAndReportPick`.
 */
class FUptimizrTelemetry
{
public:
	/**
	 * Read the live bridge's `protocolVersion` and assert it equals
	 * `UPTIMIZR_BRIDGE_PROTOCOL_VERSION`. Returns false (and stays disabled) on mismatch or
	 * when no bridge is present, so a stale shim never pushes against an incompatible API.
	 */
	bool Initialize();

	/** True once `Initialize()` has succeeded against a compatible bridge. */
	bool IsInitialized() const { return bInitialized; }

	/**
	 * Sample the active camera pose and accumulate FPS, pushing a pose every frame and a
	 * perf sample roughly once per second. Pass the world your gameplay runs in and the
	 * frame's delta seconds. No-op until `Initialize()` succeeds.
	 */
	void Tick(UWorld* World, float DeltaSeconds);

	/**
	 * Push a developer-named object and the RAW world-space hit point (cm, z-up,
	 * left-handed). Call this from your own interaction code when a pick resolves.
	 */
	void ReportPick(const FString& ObjectName, const FVector& WorldHitPoint);

	/**
	 * Convenience: line-trace forward from the active camera and, on a hit, report the hit
	 * actor's name + impact point via {@link ReportPick}. Returns true if something was hit.
	 */
	bool TraceAndReportPick(UWorld* World, float MaxDistanceCm = 1.0e5f);

	/** Stop pushing; safe to call repeatedly. */
	void Shutdown();

private:
	bool bInitialized = false;

	// FPS / long-frame accumulation across a ~1s reporting window.
	float PerfWindowSeconds = 0.0f;
	int32 PerfWindowFrames = 0;
	int32 PerfWindowLongFrames = 0;
};

/** Access the process-wide telemetry instance the `extern "C"` entry points drive. */
FUptimizrTelemetry& UptimizrTelemetry();

// cwrap / ccall entry points — let the JS host drive init/teardown by symbol name if it
// prefers (e.g. `Module.cwrap('UptimizrBridge_Init', 'number', [])`). The per-frame Tick is
// intentionally NOT exported: drive it from C++ where the world/delta are already in hand.
extern "C"
{
	/** Initialize the global sampler. Returns 1 on success, 0 on protocol mismatch / no bridge. */
	int UptimizrBridge_Init();

	/** Shut the global sampler down. */
	void UptimizrBridge_Shutdown();
}
