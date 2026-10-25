import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * "Connect Claude" on the Accounts page: runs `claude setup-token` on the server so the owner
 * can get a subscription token from a phone. The CLI prints a sign-in URL; the owner signs in
 * at claude.ai, which shows a code; the code goes back to the CLI, which prints the token.
 *
 * The CLI's interface needs a terminal, so it runs under util-linux `script` (a pseudo-terminal,
 * no native module). It gets a throwaway HOME, deleted afterwards, and a minimal environment.
 * The token is returned to the caller only: never logged, never in an error message.
 */
const URL_RE = /https:\/\/[^\s"'<>]*(?:oauth|authorize)[^\s"'<>]*/i;
const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
// CSI/OSC escape sequences and other control characters the terminal UI prints.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

export class ClaudeSetupError extends Error {}

interface Session {
  id: string;
  child: ChildProcess;
  home: string;
  /** Output so far, escape codes stripped (kept only in memory, never logged). */
  output: string;
  exited: boolean;
  waiters: Set<() => void>;
  timer: NodeJS.Timeout;
}

export interface ClaudeSetupOptions {
  /** The `claude` binary (config CLAUDE_BIN); tests point it at a fake. */
  bin: string;
  /** Environment for the CLI (no server secrets). */
  env: NodeJS.ProcessEnv;
  /** How long a started sign-in stays open. */
  ttlMs?: number;
  /** How long to wait for the URL, then for the token. */
  stepTimeoutMs?: number;
}

export class ClaudeSetup {
  private session: Session | undefined;

  constructor(private readonly options: ClaudeSetupOptions) {}

  /** Starts the CLI (ending any earlier attempt) and returns the sign-in URL. */
  async start(): Promise<{ setupId: string; url: string }> {
    await this.cancel();
    const home = await mkdtemp(join(tmpdir(), "cc-claude-setup-"));
    // Wide terminal so the URL fits on one line; `exec` so killing the shell kills the CLI.
    const command = `stty cols 1000 rows 50 2>/dev/null; exec ${shellQuote(this.options.bin)} setup-token`;
    const child = spawn("script", ["-qfec", command, "/dev/null"], {
      env: { ...this.options.env, HOME: home, TERM: "xterm-256color", COLUMNS: "1000", LINES: "50", BROWSER: "none" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const session: Session = {
      id: randomUUID(),
      child,
      home,
      output: "",
      exited: false,
      waiters: new Set(),
      timer: setTimeout(() => void this.end(session), this.options.ttlMs ?? 10 * 60_000),
    };
    session.timer.unref();
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8").replace(ANSI_RE, (m) => (m === "\n" || m === "\r" ? m : ""));
      session.output = (session.output + text).slice(-64 * 1024);
      for (const w of session.waiters) w();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => {
      session.exited = true;
      for (const w of session.waiters) w();
    });
    child.on("exit", () => {
      session.exited = true;
      for (const w of session.waiters) w();
    });
    this.session = session;

    // The terminal is 1000 columns wide, so the URL arrives on one line.
    const url = await this.waitFor(session, () => URL_RE.exec(session.output)?.[0] ?? null, "Claude didn't show a sign-in link");
    return { setupId: session.id, url };
  }

  /** Sends the code from claude.ai to the CLI and returns the token it prints. */
  async finish(setupId: string, code: string): Promise<string> {
    const session = this.session;
    if (!session || session.id !== setupId || session.exited) throw new ClaudeSetupError("This sign-in has expired; press Connect again");
    const clean = code.trim();
    if (!clean || clean.length > 2048 || /[\r\n\x00-\x1f]/.test(clean)) throw new ClaudeSetupError("That doesn't look like the code from the sign-in page");
    const before = session.output.length;
    session.child.stdin?.write(clean);
    // Let the terminal UI take the text before Enter.
    await new Promise((r) => setTimeout(r, 300));
    session.child.stdin?.write("\r");
    try {
      return await this.waitFor(
        session,
        () => TOKEN_RE.exec(session.output)?.[0] ?? null,
        // A short reason, never the output (it could hold the code).
        () => (/invalid|error|failed|expired/i.test(session.output.slice(before)) ? "Claude didn't accept that code; press Connect to try again" : "Claude didn't return a token"),
      );
    } finally {
      await this.end(session);
    }
  }

  async cancel(setupId?: string): Promise<void> {
    if (this.session && (!setupId || this.session.id === setupId)) await this.end(this.session);
  }

  private waitFor<T>(session: Session, found: () => T | null, failure: string | (() => string)): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const value = found();
        if (value !== null) return done(() => resolve(value));
        if (session.exited) return done(() => reject(new ClaudeSetupError(typeof failure === "string" ? failure : failure())));
      };
      const timer = setTimeout(() => done(() => reject(new ClaudeSetupError(typeof failure === "string" ? failure : failure()))), this.options.stepTimeoutMs ?? 60_000);
      const done = (fn: () => void) => {
        clearTimeout(timer);
        session.waiters.delete(check);
        fn();
      };
      session.waiters.add(check);
      check();
    });
  }

  private async end(session: Session): Promise<void> {
    if (this.session === session) this.session = undefined;
    clearTimeout(session.timer);
    if (!session.exited && session.child.pid) {
      try {
        process.kill(-session.child.pid, "SIGKILL"); // the whole group: script and the CLI
      } catch {
        session.child.kill("SIGKILL");
      }
    }
    session.output = "";
    await rm(session.home, { recursive: true, force: true }).catch(() => {});
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
