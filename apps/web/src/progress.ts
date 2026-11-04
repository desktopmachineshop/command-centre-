import type { AgentMessage } from "@cc/core";

/** Tool names (as the agent runtime reports them) in plain English, present tense. */
const TOOL_LINES: Array<[RegExp, string]> = [
  [/^(Read|NotebookRead)$/, "Reading files"],
  [/^(Edit|Write|MultiEdit|NotebookEdit)$/, "Making changes"],
  [/^(Grep|Glob)$/, "Searching the code"],
  [/^Bash$/, "Running a command"],
  [/^(WebSearch|WebFetch)$/, "Looking something up on the web"],
  [/^(Agent|Task)$/, "Handing a piece to another agent"],
  [/brain__(search|list|read)$/, "Checking my notes"],
  [/brain__(write|append_journal)$/, "Saving a note"],
  [/github__/, "Checking GitHub"],
  [/propose_action$/, "Proposing an action"],
  [/handoff_to_role$/, "Handing the work to another role"],
  [/^mcp__([a-z0-9-]+)__/, "Using a tool"],
];

/** What an agent message means in a few plain words, or null when it isn't progress worth showing (text, results, session noise). */
export function describeActivity(message: AgentMessage): string | null {
  if (message.type !== "tool_use") return null;
  for (const [re, line] of TOOL_LINES) if (re.test(message.name)) return line;
  return "Working on it";
}

/** The command line flavour: the tool and a short hint of its input, e.g. `Bash  pnpm test`. */
export function describeCommand(message: AgentMessage): string | null {
  if (message.type !== "tool_use") return null;
  const input = (message.input ?? {}) as Record<string, unknown>;
  const hint = [input.command, input.file_path, input.pattern, input.query, input.url, input.description].find((v) => typeof v === "string" && v) as string | undefined;
  const short = hint ? hint.replace(/\s+/g, " ").slice(0, 80) : "";
  return short ? `${message.name}  ${short}` : message.name;
}

/** The newest progress line in a run's messages, as a command line status. */
export function latestCommand(messages: AgentMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = describeCommand(messages[i]!);
    if (line) return line;
  }
  return null;
}

/**
 * Decides which progress lines are worth saying aloud on a long run: never more
 * than one every `everyMs`, none in the first `firstAfterMs`, never the same line
 * twice in a row. Pure, so it is tested without a clock or a speaker.
 */
export class ProgressNarrator {
  private startedAt = 0;
  private lastSpokenAt = 0;
  private lastLine: string | null = null;

  constructor(
    private readonly everyMs = 25_000,
    private readonly firstAfterMs = 10_000,
  ) {}

  start(now: number) {
    this.startedAt = now;
    this.lastSpokenAt = 0;
    this.lastLine = null;
  }

  /** The line to say for this message at `now`, or null to stay quiet. */
  next(message: AgentMessage, now: number): string | null {
    const line = describeActivity(message);
    if (!line || line === this.lastLine) return null;
    if (now - this.startedAt < this.firstAfterMs) return null;
    if (this.lastSpokenAt && now - this.lastSpokenAt < this.everyMs) return null;
    this.lastSpokenAt = now;
    this.lastLine = line;
    return `${line}.`;
  }

  /** Something else was spoken (a canned "still working"): count it so lines don't pile up. */
  spoke(now: number) {
    this.lastSpokenAt = now;
  }
}
