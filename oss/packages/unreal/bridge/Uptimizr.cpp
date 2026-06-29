// Uptimizr — Unreal Engine (web export) telemetry bridge shim implementation.
// See Uptimizr.h for the contract, feasibility notes, and privacy rules (ADR 0045 / 0003).

#include "Uptimizr.h"

#include "Camera/PlayerCameraManager.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "GameFramework/PlayerController.h"

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>

// --- C++ -> JS glue (EM_JS) -------------------------------------------------------------
//
// Each macro embeds a tiny JS body that forwards to the connector's EngineBridge on
// `window.__uptimizr_unreal__`. All numeric args are RAW Unreal world-space values; the JS
// connector does the z-up -> y-up rebase and cm -> m scale. The bridge is looked up fresh on
// every call so teardown (`dispose()` removing the global) cleanly turns pushes into no-ops.

// Returns the live bridge's protocol version, or -1 when no bridge is attached yet.
EM_JS(int, UptimizrBridgeProtocolVersionJS, (), {
	var b = (typeof window !== 'undefined') ? window['__uptimizr_unreal__'] : undefined;
	return (b && typeof b.protocolVersion === 'number') ? b.protocolVersion : -1;
});

EM_JS(void, UptimizrPushPoseJS,
	(double px, double py, double pz,
	 double fx, double fy, double fz,
	 double ux, double uy, double uz, double fov), {
	var b = (typeof window !== 'undefined') ? window['__uptimizr_unreal__'] : undefined;
	if (b) b.pushPose([px, py, pz], [fx, fy, fz], [ux, uy, uz], fov);
});

EM_JS(void, UptimizrPushPickJS, (const char* name, double hx, double hy, double hz), {
	var b = (typeof window !== 'undefined') ? window['__uptimizr_unreal__'] : undefined;
	if (b) b.pushPick(UTF8ToString(name), [hx, hy, hz]);
});

EM_JS(void, UptimizrPushPerfJS, (double fps, int longFrames), {
	var b = (typeof window !== 'undefined') ? window['__uptimizr_unreal__'] : undefined;
	if (b) b.pushPerf(fps, longFrames);
});

#else // !__EMSCRIPTEN__ — non-web builds (e.g. desktop editor): compile to no-ops.

static int UptimizrBridgeProtocolVersionJS()
{
	return -1;
}
static void UptimizrPushPoseJS(double, double, double, double, double, double, double, double,
	double, double)
{
}
static void UptimizrPushPickJS(const char*, double, double, double) {}
static void UptimizrPushPerfJS(double, int) {}

#endif // __EMSCRIPTEN__

namespace
{
	// Emit a perf sample roughly this often.
	constexpr float UPTIMIZR_PERF_WINDOW_SECONDS = 1.0f;
	// A frame slower than this (ms) counts as a long frame (matches the JS-only tier default).
	constexpr float UPTIMIZR_JANK_FRAME_MS = 50.0f;

	APlayerCameraManager* ResolveCameraManager(UWorld* World)
	{
		if (!World)
		{
			return nullptr;
		}
		APlayerController* PC = World->GetFirstPlayerController();
		return PC ? PC->PlayerCameraManager : nullptr;
	}
}

bool FUptimizrTelemetry::Initialize()
{
	const int Reported = UptimizrBridgeProtocolVersionJS();
	if (Reported != UPTIMIZR_BRIDGE_PROTOCOL_VERSION)
	{
		// No bridge yet, or a version this shim was not authored against — stay disabled
		// rather than push against an incompatible API.
		UE_LOG(LogTemp, Warning,
			TEXT("[Uptimizr] bridge protocol mismatch: shim=%d live=%d — telemetry disabled."),
			UPTIMIZR_BRIDGE_PROTOCOL_VERSION, Reported);
		bInitialized = false;
		return false;
	}

	bInitialized = true;
	PerfWindowSeconds = 0.0f;
	PerfWindowFrames = 0;
	PerfWindowLongFrames = 0;
	return true;
}

void FUptimizrTelemetry::Tick(UWorld* World, float DeltaSeconds)
{
	if (!bInitialized)
	{
		return;
	}

	if (APlayerCameraManager* Cam = ResolveCameraManager(World))
	{
		// RAW Unreal world-space: centimeters, z-up, left-handed. Pushed unconverted.
		const FVector Loc = Cam->GetCameraLocation();
		const FRotator Rot = Cam->GetCameraRotation();
		const FVector Fwd = Rot.Vector();
		const FVector Up = FRotationMatrix(Rot).GetUnitAxis(EAxis::Z);
		// UE exposes horizontal FOV in degrees; the bridge wants radians. (Vertical vs
		// horizontal is best-effort — the connector only uses it as a coarse frustum hint.)
		const double FovRad = FMath::DegreesToRadians(Cam->GetFOVAngle());

		UptimizrPushPoseJS(Loc.X, Loc.Y, Loc.Z, Fwd.X, Fwd.Y, Fwd.Z, Up.X, Up.Y, Up.Z, FovRad);
	}

	// Accumulate FPS over a ~1s window so we push a stable rate, not per-frame noise.
	PerfWindowSeconds += DeltaSeconds;
	PerfWindowFrames += 1;
	if (DeltaSeconds * 1000.0f > UPTIMIZR_JANK_FRAME_MS)
	{
		PerfWindowLongFrames += 1;
	}

	if (PerfWindowSeconds >= UPTIMIZR_PERF_WINDOW_SECONDS && PerfWindowFrames > 0)
	{
		const double Fps = static_cast<double>(PerfWindowFrames) / PerfWindowSeconds;
		UptimizrPushPerfJS(Fps, PerfWindowLongFrames);
		PerfWindowSeconds = 0.0f;
		PerfWindowFrames = 0;
		PerfWindowLongFrames = 0;
	}
}

void FUptimizrTelemetry::ReportPick(const FString& ObjectName, const FVector& WorldHitPoint)
{
	if (!bInitialized || ObjectName.IsEmpty())
	{
		return;
	}
	// RAW world-space hit point (cm, z-up, left-handed).
	UptimizrPushPickJS(TCHAR_TO_UTF8(*ObjectName), WorldHitPoint.X, WorldHitPoint.Y,
		WorldHitPoint.Z);
}

bool FUptimizrTelemetry::TraceAndReportPick(UWorld* World, float MaxDistanceCm)
{
	if (!bInitialized)
	{
		return false;
	}
	APlayerCameraManager* Cam = ResolveCameraManager(World);
	if (!Cam)
	{
		return false;
	}

	const FVector Start = Cam->GetCameraLocation();
	const FVector End = Start + Cam->GetCameraRotation().Vector() * MaxDistanceCm;

	FHitResult Hit;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(UptimizrPick), /*bTraceComplex=*/false);
	if (!World->LineTraceSingleByChannel(Hit, Start, End, ECC_Visibility, Params))
	{
		return false;
	}

	// Only the developer-assigned object name crosses the bridge (ADR 0003) — never input
	// text or invented identifiers.
	const AActor* HitActor = Hit.GetActor();
	if (!HitActor)
	{
		return false;
	}
	ReportPick(HitActor->GetName(), Hit.ImpactPoint);
	return true;
}

void FUptimizrTelemetry::Shutdown()
{
	bInitialized = false;
}

FUptimizrTelemetry& UptimizrTelemetry()
{
	static FUptimizrTelemetry Instance;
	return Instance;
}

extern "C"
{
	int UptimizrBridge_Init()
	{
		return UptimizrTelemetry().Initialize() ? 1 : 0;
	}

	void UptimizrBridge_Shutdown()
	{
		UptimizrTelemetry().Shutdown();
	}
}
