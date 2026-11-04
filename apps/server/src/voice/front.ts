import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Drive mode's fast voice front. One warm Claude Code process (`claude -p` with stream-json in
 * and out, no tools, no MCP), signed in like the agents, answers in about a second and streams
 * its words so speech starts on the first sentence. Anything that needs Dave's data or an
 * action it hands to the agents: it says a short natural line and ends with the handoff marker.
 */

export const HANDOFF = "[[handoff]]";

export const FRONT_SYSTEM_PROMPT = `You are the voice of Dave's Command Centre: the friendly, quick front desk he talks to while driving. Everything you write is read aloud by a speech engine.

How to speak:
- Talk like a capable British assistant on the phone: warm, relaxed, natural. Use contractions. Lead with the answer.
- One to three short sentences. One idea per sentence. No lists, markdown, emoji, URLs or code.
- Say numbers, times and money as people say them ("about three thirty", "forty pounds").

What you can do yourself (no tools): chat, small talk, general knowledge, maths, wording help, the date and time given below, and anything already said in this conversation.

What you cannot do yourself: anything about Dave's businesses, orders, customers, email, calendar, stock, tasks, approvals detail, the web, or any action (sending, booking, changing, checking, looking up). You have no access to that data and must never guess it. For those, the agents do the work:
- Reply with one short, natural acknowledgement that shows you understood (e.g. "Sure, I'll check where order ten forty-two is.", "On it, I'll draft that reply to Sarah."). Don't promise a time. Don't say "agent".
- Then end your message with ${HANDOFF} on its own.
When unsure whether you can answer from what you know, hand off.

Each message from Dave starts with a context line in brackets (time, who he's talking to, what's pending). Never read it out.`;

export interface FrontTurn {
  /** Dave's words. */
  text: string;
  /** Who requests go to, e.g. "the Chief of Staff" or "Shop: Customer Support". */
  talkingTo?: string;
  /** The last thing said to Dave (e.g. an agent's answer), so follow-ups make sense. */
  lastSpoken?: string | null;
  /** e.g. "2 approvals waiting". */
  pending?: string;
}

export interface FrontEvents {
  onDelta: (text: string) => void;
}

export interface FrontResult {
  text: string;
  handoff: boolean;
}

export interface VoiceFrontOptions {
  bin?: string;
  /** The process environment (sign-in); a function is read at each (re)start. */
  env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  model: string;
  /** Working folder (kept empty so no project settings or CLAUDE.md apply). */
  cwd: string;
  timeZone: string;
  /** No first word within this long fails the turn, so Drive falls back to the agent path. */
  firstTokenMs?: number;
  /** The warm process is stopped after this long unused. */
  idleMs?: number;
  now?: () => Date;
  /** For tests: spawns a stand-in process. */
  spawn?: (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  log?: (line: string) => void;
}

/**
 * Splits the front's streamed text into what Dave hears and whether it handed off: the marker,
 * which may arrive split across deltas, is never passed on. Pure (state in the instance).
 */
export class FrontStreamSplitter {
  private held = "";
  handoff = false;

  push(delta: string): string {
    if (this.handoff) return "";
    const text = this.held + delta;
    const at = text.indexOf(HANDOFF);
    if (at >= 0) {
      this.handoff = true;
      this.held = "";
      return text.slice(0, at);
    }
    // Hold back a tail that could be the start of the marker.
    let keep = 0;
    for (let n = Math.min(HANDOFF.length - 1, text.length); n > 0; n--) {
      if (HANDOFF.startsWith(text.slice(-n))) {
        keep = n;
        break;
      }
    }
    this.held = text.slice(text.length - keep);
    return text.slice(0, text.length - keep);
  }

  flush(): string {
    const rest = this.handoff ? "" : this.held;
    this.held = "";
    return rest;
  }
}

type Pending = {
  splitter: FrontStreamSplitter;
  events: FrontEvents;
  spoken: string;
  first: boolean;
  resolve: (r: FrontResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class VoiceFront {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending: Pending | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private stderr = "";
  /** Turns already finished at `message_stop` whose `result` line is still to come. */
  private staleResults = 0;

  constructor(private readonly options: VoiceFrontOptions) {}

  /** Starts the process ahead of the first turn (Drive mode opening), so that turn is quick. */
  warm(): void {
    try {
      this.ensure();
    } catch (err) {
      this.log(`couldn't start: ${(err as Error).message}`);
    }
  }

  /** One turn: streams the spoken text through `events.onDelta`, resolves when it's complete. */
  turn(input: FrontTurn, events: FrontEvents): Promise<FrontResult> {
    const run = this.chain.then(() => this.runTurn(input, events));
    this.chain = run.catch(() => {});
    return run;
  }

  stop(): void {
    clearTimeout(this.idle);
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  /** The bracketed context line plus Dave's words. Pure. */
  static message(input: FrontTurn, now: Date, timeZone: string): string {
    const when = now.toLocaleString("en-GB", { timeZone, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", hour12: true });
    const context = [`It is ${when}`];
    if (input.talkingTo) context.push(`requests go to ${input.talkingTo}`);
    if (input.pending) context.push(input.pending);
    if (input.lastSpoken) context.push(`last thing Dave heard: "${input.lastSpoken.slice(0, 400)}"`);
    return `[${context.join("; ")}]\n${input.text}`;
  }

  private runTurn(input: FrontTurn, events: FrontEvents): Promise<FrontResult> {
    return new Promise<FrontResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.ensure();
      } catch (err) {
        return reject(err as Error);
      }
      const timer = setTimeout(() => this.fail(new Error("the voice front was too slow to answer")), this.options.firstTokenMs ?? 8000);
      this.pending = { splitter: new FrontStreamSplitter(), events, spoken: "", first: true, resolve, reject, timer };
      const message = VoiceFront.message(input, this.options.now?.() ?? new Date(), this.options.timeZone);
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: message } })}\n`);
      this.touch();
    });
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    this.staleResults = 0;
    mkdirSync(this.options.cwd, { recursive: true });
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      this.options.model,
      "--system-prompt",
      FRONT_SYSTEM_PROMPT,
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--no-session-persistence",
    ];
    const bin = this.options.bin ?? "claude";
    const started = Date.now();
    const child = (this.options.spawn ?? ((b, a, o) => spawn(b, a, { ...o, stdio: ["pipe", "pipe", "pipe"] })))(bin, args, {
      cwd: this.options.cwd,
      env: typeof this.options.env === "function" ? this.options.env() : this.options.env,
    });
    this.child = child;
    this.stderr = "";
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    child.stderr.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    child.on("error", (err) => this.fail(new Error(`couldn't start ${bin}: ${err.message}`)));
    child.on("close", (code) => {
      if (this.child === child) this.child = null;
      this.fail(new Error(`the voice front stopped (code ${code}). ${this.stderr.trim()}`.trim()));
    });
    this.log(`warm session started (${Date.now() - started} ms to spawn)`);
    this.touch();
    return child;
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "result" && this.staleResults > 0) {
      this.staleResults--;
      return;
    }
    const p = this.pending;
    if (!p) return;
    if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
      const text = p.splitter.push(String(msg.event.delta.text ?? ""));
      if (p.first) {
        p.first = false;
        clearTimeout(p.timer);
      }
      if (text) {
        p.spoken += text;
        p.events.onDelta(text);
      }
      return;
    }
    // The reply is complete at message_stop; the CLI's `result` line follows seconds later.
    const stop = msg.type === "stream_event" && msg.event?.type === "message_stop";
    if (stop || msg.type === "result") {
      if (stop) this.staleResults++;
      const rest = p.splitter.flush();
      if (rest) {
        p.spoken += rest;
        p.events.onDelta(rest);
      }
      clearTimeout(p.timer);
      this.pending = null;
      if (!stop && (msg.is_error === true || (msg.subtype && msg.subtype !== "success"))) {
        p.reject(new Error(typeof msg.result === "string" ? msg.result : "the voice front failed"));
        return;
      }
      p.resolve({ text: p.spoken.trim(), handoff: p.splitter.handoff });
    }
  }

  private fail(err: Error) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.reject(err);
    // A stuck or broken process is replaced on the next turn.
    this.stop();
  }

  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.pending) return this.touch();
      this.log("warm session stopped after idling");
      this.stop();
    }, this.options.idleMs ?? 10 * 60_000);
    this.idle.unref?.();
  }

  private log(line: string) {
    (this.options.log ?? ((l) => console.log(`[voice-front] ${l}`)))(line);
  }
}
