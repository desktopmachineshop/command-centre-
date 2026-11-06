import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexAuthProblem } from "../codex-home";

/**
 * "Connect ChatGPT" on the Accounts page: runs `codex login --device-auth` on the server, so the
 * owner can sign in to ChatGPT from a phone. The CLI prints a link and a one-time code; the
 * owner opens the link, signs in and enters the code; the CLI then writes CODEX_HOME/auth.json
 * and exits. The page polls `status` until then.
 *
 * It runs in a throwaway CODEX_HOME (deleted afterwards) with a minimal environment. The
 * sign-in file goes to the caller only: never logged, never in an error message.
 */
const URL_RE = /https:\/\/[^\s"'<>]*device[^\s"'<>]*/i;
const ANY_URL_RE = /https:\/\/auth\.openai\.com[^\s"'<>]*/i;
/** Device codes look like ABCD-EFGH or ABCD-12345. */
const CODE_RE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export class CodexSetupError extends Error {}

export type CodexSetupStatus = { status: "pending" } | { status: "signed-in"; authJson: string } | { status: "failed"; message: string };

interface Session {
  id: string;
  child: ChildProcess;
  home: string;
  output: string;
  exited: boolean;
  exitCode: number | null;
  waiters: Set<() => void>;
  timer: NodeJS.Timeout;
}

export interface CodexSetupOptions {
  /** The `codex` binary (config CODEX_BIN); tests point it at a fake. */
  bin: string;
  /** Environment for the CLI (no server secrets). */
  env: NodeJS.ProcessEnv;
  /** How long a started sign-in stays open (Codex's code lasts 15 minutes). */
  ttlMs?: number;
  /** How long to wait for the link and code. */
  stepTimeoutMs?: number;
}

export class CodexSetup {
  private session: Session | undefined;

  constructor(private readonly options: CodexSetupOptions) {}

  /** Starts the CLI (ending any earlier attempt) and returns the sign-in link and one-time code. */
  async start(): Promise<{ setupId: string; url: string; code: string }> {
    await this.cancel();
    const home = await mkdtemp(join(tmpdir(), "cc-codex-setup-"));
    const child = spawn(this.options.bin, ["login", "--device-auth", "-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"'], {
      env: { ...this.options.env, CODEX_HOME: home, NO_COLOR: "1", BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const session: Session = {
      id: randomUUID(),
      child,
      home,
      output: "",
      exited: false,
      exitCode: null,
      waiters: new Set(),
      timer: setTimeout(() => void this.end(session), this.options.ttlMs ?? 15 * 60_000),
    };
    session.timer.unref();
    const onData = (chunk: Buffer) => {
      session.output = (session.output + chunk.toString("utf8").replace(ANSI_RE, "")).slice(-64 * 1024);
      for (const w of session.waiters) w();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const exited = (code: number | null) => {
      session.exited = true;
      session.exitCode = code;
      for (const w of session.waiters) w();
    };
    child.on("error", () => exited(null));
    child.on("exit", (code) => exited(code));
    this.session = session;

    const found = await this.waitFor(session, () => {
      const url = URL_RE.exec(session.output)?.[0] ?? ANY_URL_RE.exec(session.output)?.[0];
      // The code is printed after the link.
      const code = url ? CODE_RE.exec(session.output.slice(session.output.indexOf(url) + url.length))?.[0] : undefined;
      return url && code ? { url, code } : null;
    });
    if (!found) {
      const reason = session.exited ? lastLine(session.output) : "";
      await this.end(session);
      throw new CodexSetupError(`Codex didn't show a sign-in link and code${reason ? `: ${reason}` : ""}`);
    }
    return { setupId: session.id, ...found };
  }

  /** Where the sign-in is. Once it has finished (either way) the session is gone. */
  async status(setupId: string): Promise<CodexSetupStatus> {
    const session = this.session;
    if (!session || session.id !== setupId) return { status: "failed", message: "This sign-in has expired; press Connect again" };
    if (!session.exited) return { status: "pending" };
    try {
      const authJson = await readFile(join(session.home, "auth.json"), "utf8").catch(() => null);
      if (session.exitCode === 0 && authJson && !codexAuthProblem(authJson)) return { status: "signed-in", authJson };
      const reason = lastLine(session.output);
      return { status: "failed", message: `ChatGPT sign-in didn't finish${reason ? `: ${reason}` : ""}. Press Connect to try again.` };
    } finally {
      await this.end(session);
    }
  }

  async cancel(setupId?: string): Promise<void> {
    if (this.session && (!setupId || this.session.id === setupId)) await this.end(this.session);
  }

  private waitFor<T>(session: Session, found: () => T | null): Promise<T | null> {
    return new Promise((resolve) => {
      const check = () => {
        const value = found();
        if (value !== null) return done(value);
        if (session.exited) return done(null);
      };
      const timer = setTimeout(() => done(null), this.options.stepTimeoutMs ?? 60_000);
      const done = (value: T | null) => {
        clearTimeout(timer);
        session.waiters.delete(check);
        resolve(value);
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
        process.kill(-session.child.pid, "SIGKILL");
      } catch {
        session.child.kill("SIGKILL");
      }
    }
    session.output = "";
    await rm(session.home, { recursive: true, force: true }).catch(() => {});
  }
}

/** The CLI's last line of output, for an error message (it never holds the tokens, which go to a file). */
function lastLine(output: string): string {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^WARNING: proceeding|^stack backtrace|^\d+:|^note:/i.test(l));
  return (lines.at(-1) ?? "").slice(0, 300);
}
