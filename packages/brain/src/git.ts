import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface GitIdentity {
  name: string;
  email: string;
}

/** Minimal git wrapper; every call is serialised so commits never interleave. */
export class Git {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    private readonly identity: GitIdentity,
  ) {}

  run(...args: string[]): Promise<string> {
    const next = this.queue.then(() => this.exec(args));
    this.queue = next.catch(() => {});
    return next;
  }

  private async exec(args: string[]): Promise<string> {
    const { stdout } = await exec(
      "git",
      ["-c", `user.name=${this.identity.name}`, "-c", `user.email=${this.identity.email}`, ...args],
      { cwd: this.dir, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout;
  }

  static async clone(url: string, dir: string): Promise<void> {
    await exec("git", ["clone", "--quiet", url, dir]);
  }
}
