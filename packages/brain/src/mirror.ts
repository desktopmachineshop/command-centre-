import type { GitBrain } from "./brain";
import type { PgBrain } from "./pg";

export interface GitMirrorOptions {
  /** Quiet period after the last change before exporting. Default 60s. */
  delayMs?: number;
  log?: (message: string) => void;
}

/**
 * Keeps a git repo as a read-only copy of the Postgres brain, for Obsidian and
 * backups, and imports that repo once when the database brain is still empty.
 * Exports are debounced so a burst of agent writes becomes one commit.
 */
export class GitMirror {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: PgBrain,
    private readonly git: GitBrain,
    private readonly options: GitMirrorOptions = {},
  ) {}

  /** Copy every note from the git brain into an empty database brain. Returns how many. */
  async importIfEmpty(): Promise<number> {
    if (!(await this.db.isEmpty())) return 0;
    const paths = await this.git.list();
    for (const path of paths) {
      const note = await this.git.read(path);
      if (note) await this.db.write(path, note, { author: "import", message: "brain: import from git" });
    }
    if (paths.length) this.log(`imported ${paths.length} notes from git`);
    return paths.length;
  }

  /** Export after the quiet period; later calls push the export back. */
  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.exportNow();
    }, this.options.delayMs ?? 60_000);
    this.timer.unref?.();
  }

  /** Write the whole database brain to git as one commit. Never throws; returns whether it committed. */
  exportNow(): Promise<boolean> {
    const next = this.running.then(async () => {
      try {
        const changed = await this.git.replaceAll(await this.db.all(), `brain: mirror from command centre (${new Date().toISOString()})`);
        if (changed) this.log("exported to git");
        return changed;
      } catch (err) {
        this.log(`export failed: ${(err as Error).message}`);
        return false;
      }
    });
    this.running = next;
    return next;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private log(message: string) {
    (this.options.log ?? ((m) => console.log(`[brain] ${m}`)))(message);
  }
}
