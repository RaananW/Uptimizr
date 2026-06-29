// UptimizrGodot.cs — C# engine-side bridge for the @uptimizr/godot connector (ADR 0045).
//
// Copy-in asset (Apache-2.0). NOT a NuGet/npm package. C# parity of UptimizrGodot.gd for
// Godot 4 .NET projects. Add it as an Autoload singleton to enable the connector's
// *bridged tier* (camera pose / world-space picks / FPS / scene proxy). The *JS-only
// tier* (pointer heatmaps + FPS + JS errors) already works with no engine code.
//
// Setup:
//   1. Load @uptimizr/godot in the Web export's host page and call `trackGodot(...)`,
//      which exposes the bridge on `window.__uptimizr_godot__`.
//   2. Project > Project Settings > Globals > Autoload: add this script as `UptimizrGodot`.
//
// This shim carries NO analytics logic, IDs, or schema knowledge. It hands **world-space
// values in Godot's NATIVE frame** (right-handed, y-up, meters) to the connector, which
// owns all normalization (negates Z) and schema mapping.
//
// Privacy (ADR 0003): only poses, FPS, and developer-named objects cross the bridge. It
// MUST NOT invent identifiers or forward raw input.
using Godot;

public partial class UptimizrGodot : Node
{
    // Expected bridge wire-protocol version (must match BRIDGE_PROTOCOL_VERSION in
    // @uptimizr/web-export).
    private const int ProtocolVersion = 1;

    // The `window` property the connector exposes the bridge on.
    private const string BridgeGlobal = "__uptimizr_godot__";

    // Nodes in this group are included when PushSceneProxy() is called (opt-in).
    private const string SceneProxyGroup = "uptimizr_tracked";

    /// <summary>Push at most this many camera poses per second. Set &lt;= 0 to push every frame.</summary>
    [Export] public float PoseSamplesPerSecond = 30.0f;

    /// <summary>When true, a left click casts a ray and pushes the first named collider hit.</summary>
    [Export] public bool CapturePicks = true;

    /// <summary>Physics ray length (metres) used for click picks.</summary>
    [Export] public float PickRayLength = 1000.0f;

    private JavaScriptObject _bridge;
    private bool _readyOk;
    private float _accum;

    public override void _Ready()
    {
        if (!OS.HasFeature("web"))
        {
            SetProcess(false);
            SetProcessUnhandledInput(false);
            return;
        }

        _bridge = JavaScriptBridge.GetInterface(BridgeGlobal);
        if (_bridge == null)
        {
            GD.PushWarning($"[Uptimizr] bridge global '{BridgeGlobal}' not found — call trackGodot() in the host page before this autoload runs.");
            SetProcess(false);
            SetProcessUnhandledInput(false);
            return;
        }

        var version = (int)_bridge.Get("protocolVersion");
        if (version != ProtocolVersion)
        {
            GD.PushWarning($"[Uptimizr] bridge protocol mismatch (page={version}, shim={ProtocolVersion}) — disabling pose/pick capture.");
            _bridge = null;
            SetProcess(false);
            SetProcessUnhandledInput(false);
            return;
        }

        _readyOk = true;
    }

    public override void _Process(double delta)
    {
        if (!_readyOk)
            return;

        if (PoseSamplesPerSecond > 0.0f)
        {
            _accum += (float)delta;
            float interval = 1.0f / PoseSamplesPerSecond;
            if (_accum < interval)
            {
                PushPerf();
                return;
            }
            _accum = 0.0f;
        }

        PushPose();
        PushPerf();
    }

    private void PushPose()
    {
        var cam = GetViewport().GetCamera3D();
        if (cam == null)
            return;
        var xform = cam.GlobalTransform;
        var p = xform.Origin;
        // Godot cameras look down their local -Z; pass the WORLD-space forward vector.
        var f = -xform.Basis.Z;
        var u = xform.Basis.Y;
        // Camera3D.Fov is vertical degrees by default (KEEP_HEIGHT); the bridge wants radians.
        _bridge.Call("pushPose", Vec3(p), Vec3(f), Vec3(u), Mathf.DegToRad(cam.Fov));
    }

    private void PushPerf()
    {
        _bridge.Call("pushPerf", Engine.GetFramesPerSecond());
    }

    public override void _UnhandledInput(InputEvent @event)
    {
        if (!_readyOk || !CapturePicks)
            return;
        if (@event is InputEventMouseButton mb && mb.Pressed && mb.ButtonIndex == MouseButton.Left)
            PushPickAt(mb.Position);
    }

    private void PushPickAt(Vector2 screenPos)
    {
        var cam = GetViewport().GetCamera3D();
        if (cam == null)
            return;
        var from = cam.ProjectRayOrigin(screenPos);
        var to = from + cam.ProjectRayNormal(screenPos) * PickRayLength;
        var space = cam.GetWorld3D().DirectSpaceState;
        var query = PhysicsRayQueryParameters3D.Create(from, to);
        var hit = space.IntersectRay(query);
        if (hit.Count == 0)
            return;
        if (hit["collider"].AsGodotObject() is not Node node)
            return;
        // Only the developer-assigned node name and the world hit point are sent (ADR 0003).
        var point = hit["position"].AsVector3();
        _bridge.Call("pushPick", node.Name.ToString(), Vec3(point));
    }

    /// <summary>
    /// Push a spatial proxy of the named, developer-marked nodes in the scene-proxy group.
    /// Call this once after your scene is built (opt-in keeps the proxy low-cardinality).
    /// </summary>
    public void PushSceneProxy()
    {
        if (!_readyOk)
            return;
        var nodes = JavaScriptBridge.CreateObject("Array");
        foreach (var node in GetTree().GetNodesInGroup(SceneProxyGroup))
        {
            if (node is not VisualInstance3D vi)
                continue;
            var local = vi.GetAabb();
            var world = vi.GlobalTransform * local;
            var minP = world.Position;
            var maxP = world.Position + world.Size;
            var entry = JavaScriptBridge.CreateObject("Object");
            entry.Set("name", vi.Name.ToString());
            entry.Set("aabb", JavaScriptBridge.CreateObject(
                "Array", minP.X, minP.Y, minP.Z, maxP.X, maxP.Y, maxP.Z));
            nodes.Call("push", entry);
        }
        _bridge.Call("setSceneProxy", nodes);
    }

    /// <summary>Detach the bridge; subsequent pushes become no-ops.</summary>
    public void Dispose()
    {
        _bridge?.Call("dispose");
        _bridge = null;
        _readyOk = false;
        SetProcess(false);
        SetProcessUnhandledInput(false);
    }

    // Build a JS `[x, y, z]` array; raw arrays do not auto-marshal across the JS boundary.
    private static JavaScriptObject Vec3(Vector3 v)
    {
        return JavaScriptBridge.CreateObject("Array", v.X, v.Y, v.Z);
    }
}
