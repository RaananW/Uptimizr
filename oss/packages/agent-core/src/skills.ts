/**
 * Curated **agent skills** — the canned investigations a client can run against
 * a project's analytics (ADR 0050 §7, ADR 0051 §6).
 *
 * A skill is a named methodology: a short title, the registry tools its method
 * relies on, the arguments it accepts, and a `render` that turns those arguments
 * into the single user turn that steers an agent. No data is fetched here and no
 * model is called — a skill is pure text plus metadata, so the same definition
 * serves every consumer:
 *
 * - `@uptimizr/mcp` registers each one as an MCP **prompt template**
 *   (`prompts/list` → `prompts/get`), which is where these three started life.
 * - `uptimizr agent report --skill <name>` in the collector CLI seeds its
 *   headless `runAgent` transcript with the rendered text (ADR 0051 §6, design
 *   sketch §F.4).
 * - `@uptimizr/agent-eval` asks the bank the very questions a real client sends.
 *
 * They live here, in the package both of those already depend on, precisely so
 * there is **one** copy of the text: reword a skill and every consumer's wording
 * changes with it, with nothing to keep in step.
 *
 * ### Extending this catalog (packaged methodology skills)
 *
 * {@link getAgentSkill} is deliberately a **resolver**, not an object lookup at
 * the call site: consumers ask for a skill by name and receive an
 * {@link AgentSkill}. That indirection is the seam for packaged `SKILL.md`
 * methodology files — a later change can parse those into `AgentSkill` values
 * and register them here (or let a resolver consult a user directory first)
 * without any consumer, least of all the report CLI's `--skill` flag, changing
 * shape. Until then the catalog is exactly these three built-ins.
 */

/** One argument a skill's {@link AgentSkill.render} accepts. */
export interface AgentSkillArg {
  /** Argument name, as passed in the record given to `render`. */
  name: string;
  /** One-line description, surfaced by MCP's `prompts/list` and by `--list-skills`. */
  description: string;
  /** Whether the skill is meaningless without it. */
  required: boolean;
}

/** A named, renderable investigation methodology. */
export interface AgentSkill {
  /** Stable identifier (`weekly_scene_health`) — what `--skill` and MCP take. */
  name: string;
  /** Human title for a picker. */
  title: string;
  /** What the skill produces, in one or two sentences. */
  description: string;
  /**
   * The registry tool names the skill's method relies on, in the order its text
   * mentions them. Advisory: the agent may call others, or fewer. Consumers use
   * it to preview a run (`--dry-run`), to describe a skill, and to drive a
   * deterministic scripted provider that needs no model.
   */
  tools: readonly string[];
  /** The arguments `render` understands. */
  args: readonly AgentSkillArg[];
  /** Render the single user turn that asks for this investigation. */
  render(args?: Record<string, string | undefined>): string;
}

/**
 * The first instruction in every skill (ADR 0051 §5): orient on the project
 * before asking anything about it. Without it an agent guesses scene ids and
 * custom-event names, and reports a disabled capture channel's zero as a finding.
 *
 * Phrased for MCP (where the context document is a readable resource); the
 * report CLI injects the same document into the system prompt directly, so the
 * instruction is already satisfied by the time the model reads it.
 */
const READ_CONTEXT_FIRST =
  "Read the `uptimizr://context` resource first: it gives the real scene ids, region ids and " +
  "custom-event names for this project, and tells you which metrics are empty because their " +
  "capture channel is off.\n\n";

const forScene = (scene: string | undefined): string =>
  scene ? `scene "${scene}"` : "the project (all scenes)";

/** The optional `scene` argument shared by the project-wide skills. */
const OPTIONAL_SCENE: AgentSkillArg = {
  name: "scene",
  description: "Optional scene id to scope the analysis to (see the uptimizr://scenes resource).",
  required: false,
};

/** The required `scene` argument of the scene-specific skills. */
const REQUIRED_SCENE: AgentSkillArg = {
  name: "scene",
  description: "The scene id to analyse (see the uptimizr://scenes resource).",
  required: true,
};

/**
 * The built-in skills, in catalog order. The text of each is the contract: it is
 * what an MCP client shows its user and what the report CLI sends as the user
 * turn, so changing it changes every consumer at once (which is the point).
 */
export const AGENT_SKILLS: readonly AgentSkill[] = [
  {
    name: "weekly_scene_health",
    title: "Weekly scene health",
    description:
      "A weekly health check for a scene (or the whole project): traffic, event mix, " +
      "performance, and the most-interacted meshes.",
    tools: [
      "insight_movers",
      "insight_baseline",
      "event_counts",
      "timeseries",
      "perf_summary",
      "top_meshes",
      "list_sessions",
    ],
    args: [OPTIONAL_SCENE],
    render: ({ scene } = {}) =>
      `Give me a weekly health report for ${forScene(scene)} covering the last 7 days.\n\n` +
      READ_CONTEXT_FIRST +
      "Use these read-only tools and summarise the findings:\n" +
      "- `insight_movers` **first**" +
      (scene ? ` (scene="${scene}")` : "") +
      ": it compares every comparable metric with the previous equal window and ranks " +
      "the changes by how unusual each one is, so start from what actually moved instead " +
      "of re-deriving it. Read `direction` together with the sign of `delta` — a rise in " +
      "a `down` metric (errors, dead clicks, jank) is a regression — and do not report " +
      "any row with `aboveMinSample: false`: its delta is real arithmetic but not " +
      "evidence.\n" +
      "- `insight_baseline` for each metric that moved, to say whether the new level is " +
      "actually outside what is normal here — compare it with `median` give or take a " +
      "few `mad`, or with the p10..p90 band.\n" +
      "- `event_counts` for the per-event-type mix" +
      (scene ? ` (scene="${scene}")` : "") +
      ".\n" +
      "- `timeseries` (interval ~86400s) to show the day-by-day event volume and average FPS trend.\n" +
      "- `perf_summary` for avg/min/p50 FPS.\n" +
      "- `top_meshes` for the most-interacted meshes.\n" +
      "- `list_sessions` for how many sessions were recorded.\n\n" +
      "Call out anything unusual (traffic spikes/drops, FPS regressions, error events), " +
      "say how far outside its baseline each one sits, and end with 2–3 concrete " +
      "recommendations.",
  },
  {
    name: "attention_hotspots",
    title: "Attention hot-spots for a scene",
    description:
      "Find where visitors look and click in a scene: view-direction concentration, " +
      "gaze→mesh flow, and the objects that draw the most interaction.",
    tools: ["camera_heatmap", "flow_links", "click_rays", "top_meshes"],
    args: [REQUIRED_SCENE],
    render: ({ scene } = {}) =>
      `Where does attention concentrate in scene "${scene ?? ""}"?\n\n` +
      READ_CONTEXT_FIRST +
      'Use these read-only tools (all scoped with scene="' +
      (scene ?? "") +
      '") and synthesise the result:\n' +
      "- `camera_heatmap` for the view-direction distribution (what people look at).\n" +
      "- `flow_links` for how gaze flows into clicked meshes.\n" +
      "- `click_rays` for view-gated clicks per voxel/mesh.\n" +
      "- `top_meshes` for the most-interacted objects.\n\n" +
      "Describe the main hot-spots, any ignored/cold areas, and what that implies for the " +
      "scene's layout or call-to-action placement.",
  },
  {
    name: "xr_comfort_review",
    title: "XR comfort & drop-off review",
    description:
      "Review VR/AR comfort signals for a scene (or the whole project): rapid head rotation, " +
      "locomotion style, session abandonment, and input-source mix.",
    tools: ["xr_rotation", "xr_locomotion", "xr_abandonment", "xr_sources"],
    args: [OPTIONAL_SCENE],
    render: ({ scene } = {}) =>
      `Review XR/immersive comfort and drop-off for ${forScene(scene)}.\n\n` +
      READ_CONTEXT_FIRST +
      "Use these read-only tools" +
      (scene ? ` (scene="${scene}")` : "") +
      " and correlate the signals:\n" +
      "- `xr_rotation` for rapid head/view turns (a motion-sickness proxy).\n" +
      "- `xr_locomotion` for the fly/navigate/teleport mix and session span.\n" +
      "- `xr_abandonment` for short XR sessions that signal headset drop-off.\n" +
      "- `xr_sources` for the hand vs. controller vs. gaze input split.\n\n" +
      "Flag likely-uncomfortable patterns (heavy rapid rotation or continuous locomotion " +
      "paired with early exits) and suggest comfort mitigations.",
  },
];

/** The built-in skill names, in catalog order. */
export const AGENT_SKILL_NAMES: readonly string[] = AGENT_SKILLS.map((skill) => skill.name);

/**
 * Resolve a skill by name, or `undefined` when nothing answers to it.
 *
 * The one lookup every consumer goes through — see the module docs for why it is
 * a function rather than a bare `Record` (packaged methodology skills plug in
 * here).
 */
export function getAgentSkill(name: string): AgentSkill | undefined {
  return AGENT_SKILLS.find((skill) => skill.name === name);
}

/**
 * Render one skill's user turn, throwing on an unknown name (a typo should fail
 * loudly rather than silently produce an empty prompt) or on a missing required
 * argument.
 */
export function renderAgentSkill(
  name: string,
  args: Record<string, string | undefined> = {},
): string {
  const skill = getAgentSkill(name);
  if (!skill) {
    throw new Error(`Unknown skill "${name}". Known skills: ${AGENT_SKILL_NAMES.join(", ")}.`);
  }
  for (const arg of skill.args) {
    if (arg.required && !args[arg.name]) {
      throw new Error(`Skill "${name}" requires the "${arg.name}" argument.`);
    }
  }
  return skill.render(args);
}
