// UptimizrUnityBridge.cs — example engine-side bridge MonoBehaviour (copy-in asset).
//
// Part of the `@uptimizr/unity` connector (ADR 0045). This component is the **engine
// side** of the bridged capture tier: it samples Unity's own Camera pose, raycast
// picks, and frame timing each interval and pushes them across the WASM<->JS interop
// boundary (via the companion `Uptimizr.jslib` plugin) to the browser-side connector.
//
// It carries **no** analytics logic, IDs, or schema knowledge. Every world-space value
// is pushed in Unity's **native** frame (left-handed, y-up, meters); the connector —
// not this component — owns coordinate normalization and schema mapping (ADR 0018).
//
// Privacy (ADR 0003): only poses, FPS, and developer-named objects are sent. This
// component MUST NOT invent identifiers or forward raw input text. The pick channel
// sends only the hit GameObject's name (which you author) and the world hit point.
//
// Install:
//   1. Copy `Uptimizr.jslib` to `Assets/Plugins/WebGL/Uptimizr.jslib`.
//   2. Copy this file anywhere under `Assets/` and add the component to a GameObject.
//   3. On the host page, register the connector: `trackUnity({ ... })` (or
//      `client.use(unityCollector())`) so `window.__uptimizr_unity__` exists.
//
// Uses the legacy `UnityEngine.Input` API for broad compatibility; adapt to the new
// Input System if your project has disabled the legacy one.
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using UnityEngine;

[DisallowMultipleComponent]
public class UptimizrUnityBridge : MonoBehaviour
{
    // Must match BRIDGE_PROTOCOL_VERSION exported by `@uptimizr/web-export`.
    const int ExpectedProtocolVersion = 1;

    [Header("Camera pose")]
    [Tooltip("Camera sampled for view-direction pose. Defaults to Camera.main.")]
    public Camera targetCamera;

    [Tooltip("Seconds between camera-pose samples.")]
    public float poseSampleInterval = 0.25f;

    [Header("Performance")]
    [Tooltip("Seconds between performance (FPS / long-frame) reports.")]
    public float perfReportInterval = 2f;

    [Tooltip("Frame time (ms) above which a frame counts as a long / janky frame.")]
    public float jankFrameMs = 50f;

    [Header("Picks")]
    [Tooltip("Raycast on primary pointer-down and push the named object that was hit.")]
    public bool capturePicks = true;

    [Tooltip("Layers eligible for pick raycasts.")]
    public LayerMask pickMask = ~0;

#if UNITY_WEBGL && !UNITY_EDITOR
    [DllImport("__Internal")]
    static extern int UptimizrUnityGetProtocolVersion();

    [DllImport("__Internal")]
    static extern void UptimizrUnityPushPose(
        float px, float py, float pz,
        float fx, float fy, float fz,
        float ux, float uy, float uz,
        float fov);

    [DllImport("__Internal")]
    static extern void UptimizrUnityPushPick(string objectName, float hx, float hy, float hz);

    [DllImport("__Internal")]
    static extern void UptimizrUnityPushPerf(float fps, int longFrames);

    [DllImport("__Internal")]
    static extern void UptimizrUnitySetSceneProxy(string json);
#else
    // Editor / non-WebGL stubs so the component compiles and runs in the Editor and in
    // native builds (where there is no JS bridge to push to).
    static int UptimizrUnityGetProtocolVersion() => ExpectedProtocolVersion;

    static void UptimizrUnityPushPose(
        float px, float py, float pz,
        float fx, float fy, float fz,
        float ux, float uy, float uz,
        float fov) { }

    static void UptimizrUnityPushPick(string objectName, float hx, float hy, float hz) { }

    static void UptimizrUnityPushPerf(float fps, int longFrames) { }

    static void UptimizrUnitySetSceneProxy(string json) { }
#endif

    float poseTimer;
    float perfTimer;
    int frameCount;
    int longFrameCount;

    void Start()
    {
        int version = UptimizrUnityGetProtocolVersion();
        if (version != ExpectedProtocolVersion)
        {
            Debug.LogWarning(
                "[Uptimizr] bridge protocol mismatch: this shim expects v" +
                ExpectedProtocolVersion + " but the connector reports v" + version +
                ". Make sure trackUnity()/unityCollector() is registered on the host " +
                "page before the export loads. Disabling the bridge.");
            enabled = false;
            return;
        }

        if (targetCamera == null)
        {
            targetCamera = Camera.main;
        }
    }

    void Update()
    {
        float dt = Time.unscaledDeltaTime;

        // Performance: accumulate over a window, then report measured FPS + long frames.
        frameCount++;
        if (dt * 1000f > jankFrameMs)
        {
            longFrameCount++;
        }
        perfTimer += dt;
        if (perfTimer >= perfReportInterval && perfTimer > 0f)
        {
            float fps = frameCount / perfTimer;
            UptimizrUnityPushPerf(fps, longFrameCount);
            perfTimer = 0f;
            frameCount = 0;
            longFrameCount = 0;
        }

        Camera cam = targetCamera != null ? targetCamera : Camera.main;
        if (cam == null)
        {
            return;
        }

        // Camera pose: position / forward / up in Unity's native frame; FOV in radians.
        poseTimer += dt;
        if (poseTimer >= poseSampleInterval)
        {
            poseTimer = 0f;
            Transform t = cam.transform;
            Vector3 p = t.position;
            Vector3 f = t.forward;
            Vector3 u = t.up;
            float fovRad = cam.fieldOfView * Mathf.Deg2Rad;
            UptimizrUnityPushPose(p.x, p.y, p.z, f.x, f.y, f.z, u.x, u.y, u.z, fovRad);
        }

        // Picks: on primary pointer-down, raycast and push the named object + hit point.
        if (capturePicks && Input.GetMouseButtonDown(0))
        {
            Ray ray = cam.ScreenPointToRay(Input.mousePosition);
            if (Physics.Raycast(ray, out RaycastHit hit, Mathf.Infinity, pickMask))
            {
                Vector3 hp = hit.point;
                UptimizrUnityPushPick(hit.collider.gameObject.name, hp.x, hp.y, hp.z);
            }
        }
    }

    /// <summary>
    /// Optional one-shot: push the world-space AABBs of the given renderers as the
    /// scene proxy (for spatial context + replay). Call once after your scene is
    /// loaded. Object names come from your GameObjects — keep them non-PII (ADR 0003).
    /// </summary>
    public void PushSceneProxy(Renderer[] renderers)
    {
        if (renderers == null)
        {
            return;
        }

        var sb = new StringBuilder();
        sb.Append('[');
        bool first = true;
        foreach (Renderer r in renderers)
        {
            if (r == null)
            {
                continue;
            }
            Bounds b = r.bounds;
            Vector3 min = b.min;
            Vector3 max = b.max;
            if (!first)
            {
                sb.Append(',');
            }
            first = false;
            sb.Append("{\"name\":");
            AppendJsonString(sb, r.gameObject.name);
            sb.Append(",\"aabb\":[");
            AppendFloat(sb, min.x);
            sb.Append(',');
            AppendFloat(sb, min.y);
            sb.Append(',');
            AppendFloat(sb, min.z);
            sb.Append(',');
            AppendFloat(sb, max.x);
            sb.Append(',');
            AppendFloat(sb, max.y);
            sb.Append(',');
            AppendFloat(sb, max.z);
            sb.Append("]}");
        }
        sb.Append(']');
        UptimizrUnitySetSceneProxy(sb.ToString());
    }

    static void AppendFloat(StringBuilder sb, float v)
    {
        sb.Append(v.ToString("R", CultureInfo.InvariantCulture));
    }

    static void AppendJsonString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"':
                    sb.Append("\\\"");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '\n':
                    sb.Append("\\n");
                    break;
                case '\r':
                    sb.Append("\\r");
                    break;
                case '\t':
                    sb.Append("\\t");
                    break;
                default:
                    if (c < ' ')
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(c);
                    }
                    break;
            }
        }
        sb.Append('"');
    }
}
