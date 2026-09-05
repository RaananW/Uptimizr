// Uptimizr Unity WebGL bridge — Emscripten `.jslib` plugin (copy-in asset).
//
// Part of the `@uptimizr/unity` connector (ADR 0045). This is the **engine-side
// shim**: a small, dumb plugin that pushes per-sample telemetry from Unity's C#
// side across the WASM<->JS interop boundary to the browser-side connector. It
// carries **no** analytics logic, IDs, or schema knowledge — it just forwards to the
// versioned `EngineBridge` the connector exposes on `window.__uptimizr_unity__`.
//
// All world-space values are forwarded in Unity's **native** frame (left-handed,
// y-up, meters). The connector — not this shim — owns coordinate normalization and
// schema mapping ("one normalization point", ADR 0018). Do NOT do coordinate math
// here.
//
// Privacy (ADR 0003): only poses, FPS, and developer-named objects cross this
// boundary. The shim MUST NOT invent identifiers or forward raw input text.
//
// Install: copy this file to `Assets/Plugins/WebGL/Uptimizr.jslib` in your Unity
// project, then add the companion `UptimizrUnityBridge.cs` MonoBehaviour to a
// GameObject. The C# side calls these via `[DllImport("__Internal")]`.
mergeInto(LibraryManager.library, {
  // Resolve the connector's EngineBridge, or `null` if the connector has not started
  // yet (the host page must call `trackUnity(...)` / register `unityCollector()`).
  $UptimizrUnityBridge__deps: [],
  $UptimizrUnityBridge: {
    get: function () {
      return typeof window !== "undefined" ? window.__uptimizr_unity__ || null : null;
    },
  },

  // Returns the bridge protocol version (assert against BRIDGE_PROTOCOL_VERSION on the
  // C# side), or -1 when the connector is not present yet. Lets the shim fail loudly
  // on a contract mismatch instead of silently pushing to an incompatible bridge.
  UptimizrUnityGetProtocolVersion__deps: ["$UptimizrUnityBridge"],
  UptimizrUnityGetProtocolVersion: function () {
    var b = UptimizrUnityBridge.get();
    return b && typeof b.protocolVersion === "number" ? b.protocolVersion : -1;
  },

  // Push a camera pose. position / forward / up are world-space in Unity's native
  // frame; `fov` is the vertical field of view in **radians**, or < 0 to omit it.
  UptimizrUnityPushPose__deps: ["$UptimizrUnityBridge"],
  UptimizrUnityPushPose: function (px, py, pz, fx, fy, fz, ux, uy, uz, fov) {
    var b = UptimizrUnityBridge.get();
    if (!b) return;
    if (fov >= 0) {
      b.pushPose([px, py, pz], [fx, fy, fz], [ux, uy, uz], fov);
    } else {
      b.pushPose([px, py, pz], [fx, fy, fz], [ux, uy, uz]);
    }
  },

  // Push a raycast pick: a developer-named object and its world-space hit point in
  // Unity's native frame. `namePtr` is a UTF-8 string pointer from Unity.
  UptimizrUnityPushPick__deps: ["$UptimizrUnityBridge"],
  UptimizrUnityPushPick: function (namePtr, hx, hy, hz) {
    var b = UptimizrUnityBridge.get();
    if (!b) return;
    var name = UTF8ToString(namePtr);
    if (!name) return;
    b.pushPick(name, [hx, hy, hz]);
  },

  // Push an engine-measured performance sample. `longFrames` < 0 omits the count.
  UptimizrUnityPushPerf__deps: ["$UptimizrUnityBridge"],
  UptimizrUnityPushPerf: function (fps, longFrames) {
    var b = UptimizrUnityBridge.get();
    if (!b) return;
    if (longFrames >= 0) {
      b.pushPerf(fps, longFrames);
    } else {
      b.pushPerf(fps);
    }
  },

  // Push the scene's spatial proxy. `jsonPtr` is a UTF-8 JSON string of
  // `[{ name: string, aabb: [minX,minY,minZ,maxX,maxY,maxZ] }, ...]` in Unity's
  // native frame (arrays don't cross the DllImport boundary cleanly, so the C# side
  // serializes once). The connector normalizes + builds a wire-correct SceneProxy.
  UptimizrUnitySetSceneProxy__deps: ["$UptimizrUnityBridge"],
  UptimizrUnitySetSceneProxy: function (jsonPtr) {
    var b = UptimizrUnityBridge.get();
    if (!b) return;
    var json = UTF8ToString(jsonPtr);
    if (!json) return;
    var nodes;
    try {
      nodes = JSON.parse(json);
    } catch (e) {
      return;
    }
    if (Array.isArray(nodes)) {
      b.setSceneProxy(nodes);
    }
  },
});
