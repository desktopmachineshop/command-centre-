/**
 * The current instance of one integration (a client, its executors, its poller...), swapped
 * whole when the Accounts page changes its credentials. Consumers read `current` at call time,
 * never a copy taken at start-up.
 *
 * A swap builds the new instance first: if that throws, the old one stays in use and the error
 * comes back for the Accounts page. Otherwise the new one becomes current, the old one is
 * stopped (its pollers), and the new one is started if the server has started. Swaps, start and
 * stop run one at a time, so two reloads can't leave two pollers running.
 */
export class Live<T> {
  private value: T;
  private started = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    initial: T,
    private readonly hooks: { start?: (value: T) => void; stop?: (value: T) => Promise<void> | void } = {},
  ) {
    this.value = initial;
  }

  get current(): T {
    return this.value;
  }

  /** Replaces the instance with `build()`'s; returns why it couldn't (the old one stays). */
  swap(build: () => T | Promise<T>): Promise<string | undefined> {
    return this.serial(async () => {
      let next: T;
      try {
        next = await build();
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      const old = this.value;
      this.value = next;
      if (this.started) {
        await this.stopOne(old);
        try {
          this.hooks.start?.(next);
        } catch (err) {
          // The new one won't run: put the old one back so the server and the config agree.
          this.value = old;
          this.hooks.start?.(old);
          return err instanceof Error ? err.message : String(err);
        }
      }
      return undefined;
    });
  }

  /** Starts the current instance; later swaps start theirs. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.started) return;
      this.started = true;
      this.hooks.start?.(this.value);
    });
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      if (!this.started) return;
      this.started = false;
      await this.stopOne(this.value);
    });
  }

  private async stopOne(value: T) {
    try {
      await this.hooks.stop?.(value);
    } catch (err) {
      console.error("[integrations] stopping the old instance failed", err);
    }
  }

  private serial<R>(fn: () => Promise<R>): Promise<R> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }
}
