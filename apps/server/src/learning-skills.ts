/**
 * The skill tree: each theme ("track" in the code) as levels (foundations to expert) of skills, each skill naming the
 * ones it builds on. It lives in the brain (learning/skill-tree.md) and the coach keeps it: it
 * picks lessons from it, adds to it, and puts each lesson's skill in its frontmatter (`skill:`).
 * The Learning page shows it with what's done, what's open and what's still locked.
 */

export const SKILL_TREE_PATH = "learning/skill-tree.md";

export const SKILL_TREE_TEMPLATE = `# Skill tree

The career coach's map of what to learn, theme by theme, from foundations to expert. Each
lesson teaches one skill and says which in its frontmatter (\`skill: ai.agents\`). A skill opens
once the skills it builds on (after the arrow) have a lesson. Edit freely: add skills, move them,
change what they build on.

A theme is a \`## Name (theme-id)\` heading, with a line under it on what it covers; its levels
are \`### \` headings, easiest first. Themes are broad, each covering a whole field: a new topic
goes in the theme it fits, and only gets a new theme when it fits none. One skill per line:
\`- \\\`id\\\` Title: why it matters ← builds-on-id, another-id\`.

## AI (ai)
Everything AI: models, agents, tooling, evaluation, research, regulation and news.

### Foundations
- \`ai.ml-basics\` Machine learning in one lecture: data, loss, gradient descent and overfitting
- \`ai.llm\` How large language models work: tokens, attention, training and why they make things up
- \`ai.embeddings\` Embeddings and vector search: meaning as geometry ← ai.llm
- \`ai.prompting\` Prompting and context engineering: what goes in the window, and why it matters ← ai.llm

### Practitioner
- \`ai.tools\` Tool use and function calling: how a model drives software ← ai.prompting
- \`ai.rag\` Retrieval-augmented generation: chunking, reranking and when it isn't the answer ← ai.embeddings, ai.prompting
- \`ai.agents\` How AI agents plan and use tools: the loop behind coding and research agents, and where it breaks ← ai.tools
- \`ai.mcp\` The Model Context Protocol: how tools and data reach a model ← ai.tools
- \`ai.evals\` Evaluating LLM systems: test sets, judges and the traps in both ← ai.prompting

### Advanced
- \`ai.finetune\` Fine-tuning versus prompting versus tools: choosing the cheapest thing that works ← ai.ml-basics, ai.rag
- \`ai.multiagent\` Multi-agent systems: orchestration, hand-offs and failure modes ← ai.agents, ai.evals
- \`ai.vision\` Vision models: from convolutional networks to vision-language models ← ai.ml-basics, ai.llm
- \`ai.regulation\` The EU AI Act in practice: what applies to engineering and SaaS products, and when ← ai.evals

### Expert
- \`ai.vla\` Vision-language-action models for robots: what they can and can't do yet ← ai.vision, ai.agents
- \`ai.inference\` Serving models efficiently: quantisation, batching, speculative decoding and the cost curve ← ai.finetune
- \`ai.safety\` Alignment and safety engineering: from red-teaming to interpretability ← ai.evals, ai.multiagent

## Robotics & automation (robotics)
Robotics, industrial PLCs (Beckhoff TwinCAT first), motion control, fabrication, industrial additive manufacturing, manufacturing methods and supply chain.

### Foundations
- \`rob.iec61131\` IEC 61131-3 beyond ladder: structured text, function blocks and object orientation in TwinCAT
- \`rob.fieldbus\` Industrial networks: why fieldbuses exist, and how EtherCAT, PROFINET and EtherNet/IP differ
- \`rob.kinematics\` Robot kinematics: joints, frames, and forward and inverse kinematics
- \`rob.drives\` Motors and drives: steppers, servos and what a drive actually does

### Practitioner
- \`rob.ethercat\` EtherCAT and TwinCAT 3 motion: how distributed clocks keep axes in step ← rob.fieldbus, rob.iec61131
- \`rob.servo-tuning\` Servo tuning from first principles: current, velocity and position loops ← rob.drives
- \`rob.safety\` Safety PLCs and TwinSAFE: functional safety from risk assessment to SIL and PL ← rob.iec61131
- \`rob.vision\` Machine vision for robot guidance: calibration, hand-eye and accuracy budgets ← rob.kinematics

### Advanced
- \`rob.motion\` Trajectory generation and coordinated motion: jerk limits, cams and interpolation ← rob.ethercat, rob.servo-tuning
- \`rob.am\` Industrial metal additive manufacturing: laser powder bed fusion, DED and where each pays
- \`rob.welding\` Welding and fabrication automation: cobots, seam tracking and fixturing ← rob.vision
- \`rob.supply\` Lean supply chains for low-volume engineering: lead times, dual sourcing and buffers

### Expert
- \`rob.virtual\` Digital twins and virtual commissioning ← rob.motion
- \`rob.force\` Force control and compliant manipulation ← rob.motion, rob.safety
- \`rob.am-design\` Designing for metal additive: topology optimisation, supports and qualification ← rob.am

## SaaS & requirements (saas)
Requirements management and compliance, building and running a SaaS, hosting, and agentic workflows for requirements and projects.

### Foundations
- \`saas.requirements\` Writing good requirements: ISO/IEC/IEEE 29148 and the INCOSE rules
- \`saas.metrics\` SaaS metrics that matter early: activation, retention cohorts, churn and net revenue retention
- \`saas.web\` How a web application hangs together: requests, databases, queues and caches

### Practitioner
- \`saas.traceability\` Requirements traceability done well: from stakeholder need to verified test ← saas.requirements
- \`saas.railway\` Running production on Railway: services, volumes, private networking, scaling and cost ← saas.web
- \`saas.pricing\` SaaS pricing and packaging: value metrics, tiers and what the evidence says ← saas.metrics
- \`saas.agentic\` Agentic workflows for project management: what to automate, where people stay in the loop

### Advanced
- \`saas.compliance\` Compliance frameworks that need traceability: DO-178C, ISO 26262, IEC 61508, EN 50128 ← saas.traceability
- \`saas.multitenant\` Multi-tenant SaaS architecture: isolation, data residency and noisy neighbours ← saas.railway
- \`saas.security\` Security for a small SaaS: threat modelling, SOC 2 and ISO 27001 ← saas.web
- \`saas.mbse\` Model-based systems engineering: SysML v2 and where documents end ← saas.traceability

### Expert
- \`saas.safety-case\` Safety cases and assurance arguments: GSN and what assessors look for ← saas.compliance
- \`saas.ai-requirements\` AI in requirements engineering: what's proven and what isn't ← saas.mbse, saas.agentic
- \`saas.scale\` Scaling a SaaS: from one database to many ← saas.multitenant

## Maker & home automation (maker)
Hobby CNC and 3D printing, home electronics and automation, and hobby PLC programming (CODESYS).

### Foundations
- \`mk.cnc\` How a hobby CNC machine works: frame, drives, spindle and controller
- \`mk.fdm\` How FDM 3D printing works: extrusion, cooling and the slicer
- \`mk.esp32\` The ESP32 for automation: inputs, outputs, sensors and Wi-Fi

### Practitioner
- \`mk.rigidity\` Hobby CNC rigidity and chatter: what really limits a desktop machine ← mk.cnc
- \`mk.cam\` CAM for hobby CNC: toolpaths, feeds and speeds ← mk.cnc
- \`mk.klipper\` Klipper, input shaping and pressure advance: faster 3D printing explained ← mk.fdm
- \`mk.home-assistant\` Home Assistant and ESPHome: sensors and automations that are worth it ← mk.esp32

### Advanced
- \`mk.closed-loop\` Closed-loop steppers versus servos on a hobby machine ← mk.rigidity
- \`mk.codesys\` CODESYS on a Raspberry Pi: a real PLC runtime at home ← mk.home-assistant
- \`mk.materials\` Engineering filaments: nylon, carbon fibre and what printing them needs ← mk.klipper

### Expert
- \`mk.retrofit\` Retrofitting a hobby machine with industrial control ← mk.closed-loop, mk.codesys
- \`mk.toolchanger\` Multi-material and tool-changing printers ← mk.materials

## Tools & materials market (market)
Home-manufacturing trends, and the world news behind tool, material and motor prices.

### Foundations
- \`mkt.commodities\` How commodity prices work: futures, spot prices and who sets them
- \`mkt.trade\` How tariffs, shipping and the pound reach a UK price

### Practitioner
- \`mkt.carbide\` Why carbide end mill prices move: tungsten, cobalt and China's export controls ← mkt.commodities
- \`mkt.magnets\` Rare earth magnets and motor prices: neodymium, China and what changed ← mkt.commodities
- \`mkt.metals\` Copper and steel prices: what they do to motors, cables and machine frames ← mkt.commodities
- \`mkt.shipping\` Shipping costs and tariffs on a hobby machine bought in the UK ← mkt.trade

### Advanced
- \`mkt.desktop\` The desktop manufacturing market: who buys, what's growing, and why ← mkt.trade
- \`mkt.china\` China's industrial policy and what it means for tools and motors ← mkt.carbide, mkt.magnets

### Expert
- \`mkt.forecast\` Reading the signals: forecasting input costs for a small manufacturer ← mkt.metals, mkt.china

`;

export interface Skill {
  id: string;
  title: string;
  why: string;
  /** The skills it builds on. */
  needs: string[];
}

export interface SkillTreeTrack {
  track: string;
  name: string;
  /** The line under the theme's heading, on what it covers ("" if none). */
  description: string;
  levels: { name: string; skills: Skill[] }[];
}

const TRACK_HEADING = /^##\s+(.+?)\s*\(([a-z0-9][a-z0-9-]*)\)\s*$/i;
const SKILL_LINE = /^\s*[-*]\s+`([a-z0-9][a-z0-9.-]*)`\s+(.+?)\s*$/i;

/** The tree as written: tracks, their levels in order, and each skill. Pure. */
export function parseSkillTree(body: string): SkillTreeTrack[] {
  const tracks: SkillTreeTrack[] = [];
  let track: SkillTreeTrack | null = null;
  for (const line of body.replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    const t = TRACK_HEADING.exec(line);
    if (t) {
      track = { track: t[2]!.toLowerCase(), name: t[1]!.trim(), description: "", levels: [] };
      tracks.push(track);
      continue;
    }
    if (/^##\s/.test(line)) {
      track = null;
      continue;
    }
    if (!track) continue;
    const l = /^###\s+(.+?)\s*$/.exec(line);
    if (l) {
      track.levels.push({ name: l[1]!, skills: [] });
      continue;
    }
    const m = SKILL_LINE.exec(line);
    if (!m) {
      // The first line of prose under the heading says what the theme covers.
      if (!track.levels.length && !track.description && line.trim() && !/^\s*[-*#>]/.test(line)) track.description = line.trim();
      continue;
    }
    if (!track.levels.length) track.levels.push({ name: "Foundations", skills: [] });
    const [text, after = ""] = m[2]!.split(/\s+(?:←|<-|after:)\s+/i);
    const split = /^(.+?):\s+(.+)$/.exec(text!.trim());
    track.levels.at(-1)!.skills.push({
      id: m[1]!.toLowerCase(),
      title: (split ? split[1]! : text!).trim(),
      why: split ? split[2]!.trim() : "",
      needs: after
        .split(/[,\s]+/)
        .map((s) => s.replace(/`/g, "").trim().toLowerCase())
        .filter(Boolean),
    });
  }
  return tracks;
}

export type SkillStatus = "done" | "taught" | "open" | "locked";

/** What a skill tree shows of each lesson (Learning's Lesson, trimmed). */
export interface SkillLesson {
  path: string;
  title: string;
  topic: string;
  skill: string;
  status: string;
}

export interface SkillView extends Skill {
  /** done: a lesson on it is done; taught: it has a lesson; open: what it builds on is taught; locked: not yet. */
  status: SkillStatus;
  lessons: { path: string; title: string; status: string }[];
  /** For a locked skill, the titles of what it still waits on. */
  waitsOn: string[];
}

export interface SkillTreeView {
  path: string;
  tracks: { track: string; name: string; done: number; taught: number; total: number; levels: { name: string; skills: SkillView[] }[] }[];
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Each skill's state from the lessons: a lesson belongs to a skill by its `skill:` frontmatter, or
 * (for lessons from before the tree) by its topic or title matching the skill's. Skipped lessons
 * don't count. Pure.
 */
export function skillTreeView(tracks: SkillTreeTrack[], lessons: SkillLesson[]): SkillTreeView {
  const all = new Map<string, Skill>();
  for (const t of tracks) for (const l of t.levels) for (const s of l.skills) all.set(s.id, s);
  const byTitle = new Map<string, string>();
  for (const s of all.values()) byTitle.set(key(s.title), s.id);
  const lessonsOf = new Map<string, SkillLesson[]>();
  for (const l of lessons) {
    if (l.status === "skipped") continue;
    const id = (l.skill && all.has(l.skill.toLowerCase()) ? l.skill.toLowerCase() : null) ?? byTitle.get(key(l.topic)) ?? byTitle.get(key(l.title));
    if (!id) continue;
    lessonsOf.set(id, [...(lessonsOf.get(id) ?? []), l]);
  }
  const taught = (id: string) => (lessonsOf.get(id)?.length ?? 0) > 0;
  return {
    path: SKILL_TREE_PATH,
    tracks: tracks.map((t) => {
      let done = 0;
      let taughtCount = 0;
      let total = 0;
      const levels = t.levels.map((level) => ({
        name: level.name,
        skills: level.skills.map((s): SkillView => {
          const ls = lessonsOf.get(s.id) ?? [];
          // Something it builds on that isn't in the tree can't hold it back.
          const waits = s.needs.filter((n) => all.has(n) && !taught(n));
          const status: SkillStatus = ls.some((l) => l.status === "done") ? "done" : ls.length ? "taught" : waits.length ? "locked" : "open";
          total++;
          if (status === "done") done++;
          if (status === "done" || status === "taught") taughtCount++;
          return { ...s, status, lessons: ls.map((l) => ({ path: l.path, title: l.title, status: l.status })), waitsOn: waits.map((n) => all.get(n)!.title) };
        }),
      }));
      return { track: t.track, name: t.name, done, taught: taughtCount, total, levels };
    }),
  };
}
