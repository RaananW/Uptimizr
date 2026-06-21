// react-three-fiber engine module: mounts a React root into the engine container
// (R3F owns its own canvas, so the shared `#renderCanvas` is hidden for this engine)
// and starts the `@uptimizr/r3f` connector via its hook. Replay / heatmap / scene
// proxy are not wired for R3F, matching the connector's current surface.

import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useUptimizr, type UptimizrClientRef } from "@uptimizr/r3f";
import { Color, type Mesh } from "three";

import {
  BOX_COLORS,
  COMMON_CAPTURE_FEATURES,
  type EngineInstance,
  type EngineModule,
  type EngineMountContext,
} from "../engine.js";

const HEX_COLORS = BOX_COLORS.map(([r, g, b]) => new Color(r, g, b).getStyle());

function Telemetry({
  ctx,
  onClient,
  clientRef,
}: {
  ctx: EngineMountContext;
  onClient: () => void;
  clientRef: { current: UptimizrClientRef | null };
}): null {
  const ref = useUptimizr({
    projectId: ctx.projectId,
    endpoint: ctx.collectorUrl,
    transport: ctx.transport,
    sampling: { camera: 10, pointerMove: 30 },
    capture: toThreeCapture(ctx.capture),
    ...(ctx.keyBindings ? { keyBindings: ctx.keyBindings } : {}),
    sceneDescription: "playground (r3f)",
    meta: { sceneId: ctx.sceneId },
    user: { id: "anon-playground-user", traits: { demo: true } },
    debug: true,
  });
  clientRef.current = ref;
  useEffect(() => {
    if (ref.current) onClient();
  }, [ref, onClient]);
  return null;
}

function toThreeCapture(cap: Record<string, boolean>): Record<string, boolean> {
  return {
    camera: cap.camera ?? false,
    gaze: cap.gaze ?? false,
    pointerMove: cap.pointerMove ?? false,
    clicks: cap.clicks ?? false,
    buttons: cap.buttons ?? false,
    meshPicks: cap.meshPicks ?? false,
    perf: cap.perf ?? false,
    contextLoss: cap.contextLoss ?? false,
    meshVisibility: cap.meshVisibility ?? false,
    hoverDwell: cap.hoverDwell ?? false,
    resourceSample: cap.resourceSample ?? false,
    keyboard: cap.keyboard ?? false,
  };
}

function AutoRotateCamera(): null {
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    state.camera.position.x = Math.sin(t * 0.2) * 16;
    state.camera.position.z = Math.cos(t * 0.2) * 16;
    state.camera.position.y = 8;
    state.camera.lookAt(0, 1, 0);
  });
  return null;
}

function Box({
  name,
  position,
  color,
  onPick,
}: {
  name: string;
  position: [number, number, number];
  color: string;
  onPick: (name: string) => void;
}): React.JSX.Element {
  const ref = useRef<Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const baseColor = useMemo(() => new Color(color), [color]);

  const handleClick = (e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation();
    onPick(name);
  };

  return (
    <mesh
      ref={ref}
      name={name}
      position={position}
      onClick={handleClick}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <boxGeometry args={[2, 2, 2]} />
      <meshStandardMaterial color={baseColor} emissive={hovered ? "#3a3a44" : "#000000"} />
    </mesh>
  );
}

function PlaygroundApp({
  ctx,
  onClient,
  clientRef,
}: {
  ctx: EngineMountContext;
  onClient: () => void;
  clientRef: { current: UptimizrClientRef | null };
}): React.JSX.Element {
  const pickCount = useRef(0);
  const onPick = (name: string): void => {
    pickCount.current += 1;
    ctx.onBoxPick(name);
    clientRef.current?.current?.track("box_picked", {
      box: name,
      totalPicks: pickCount.current,
    });
  };

  return (
    <Canvas camera={{ fov: 60, position: [0, 8, 16], near: 0.1, far: 200 }}>
      <Telemetry ctx={ctx} onClient={onClient} clientRef={clientRef} />
      <AutoRotateCamera />

      <hemisphereLight args={[0xffffff, 0x303a4a, 1.0]} />
      <directionalLight position={[5, 10, 7]} intensity={0.7} />

      <mesh name="ground" rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[24, 24]} />
        <meshStandardMaterial color="#212838" />
      </mesh>

      {HEX_COLORS.map((color, i) => (
        <Box
          key={i}
          name={`box-${i}`}
          color={color}
          position={[(i - (HEX_COLORS.length - 1) / 2) * 3.2, 1, 0]}
          onPick={onPick}
        />
      ))}
    </Canvas>
  );
}

async function mount(ctx: EngineMountContext): Promise<EngineInstance> {
  const clientRef: { current: UptimizrClientRef | null } = { current: null };
  let root: Root | null = null;

  await new Promise<void>((resolve) => {
    let resolved = false;
    const onClient = (): void => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    root = createRoot(ctx.container);
    root.render(
      <StrictMode>
        <PlaygroundApp ctx={ctx} onClient={onClient} clientRef={clientRef} />
      </StrictMode>,
    );
    // Resolve even if the hook never reports (e.g. transport rejected) so the shell
    // still finishes booting; the connection indicator reflects the real status.
    setTimeout(onClient, 2000);
  });

  return {
    client: clientRef.current?.current ?? null,
    flashMesh() {
      // R3F owns its own visuals via component state; no imperative flash needed.
    },
    dispose() {
      root?.unmount();
    },
  };
}

export const engine: EngineModule = {
  id: "r3f",
  label: "react-three-fiber",
  captureFeatures: [
    ...COMMON_CAPTURE_FEATURES,
    { key: "keyboard", label: "Keyboard", default: true },
  ],
  capabilities: {
    sharedCanvas: false,
    capturePanel: true,
    sceneSwitch: false,
    walkable: false,
    cursorOverlay: false,
    inputSource: false,
    replay: false,
    heatmap: false,
    sceneProxy: false,
  },
  mount,
};
