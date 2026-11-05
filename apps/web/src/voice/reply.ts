import { SentenceAssembler } from "@cc/voice/sentences";
import type { VoiceTurnEvent } from "../api";

/**
 * A reply from Drive mode's voice front, as it streams: the words so far (for the caption),
 * the sentences to speak as each completes, and whether the request went on to an agent.
 */
export class ReplyStream {
  text = "";
  handoff: { taskId: string | null } | null = null;
  error: string | null = null;
  onText: (text: string) => void = () => {};
  /** Called once when the reply has fully arrived (or failed), whether or not it was spoken to the end. */
  onEnd: () => void = () => {};
  private readonly assembler = new SentenceAssembler();
  private readonly queue: string[] = [];
  private ended = false;
  private wake: (() => void) | null = null;
  private readonly controller = new AbortController();
  private first: ((ok: boolean) => void) | null = null;

  /**
   * Starts reading `open(signal)`. Resolves true as soon as the first words arrive (speech can
   * start), or false when the front fails or says nothing within `firstMs`, so Drive can fall
   * back to asking the agent directly.
   */
  start(open: (signal: AbortSignal) => AsyncIterable<VoiceTurnEvent>, firstMs = 6000): Promise<boolean> {
    const ready = new Promise<boolean>((resolve) => (this.first = resolve));
    const timer = setTimeout(() => {
      if (this.first) {
        this.abort();
        this.resolveFirst(false);
      }
    }, firstMs);
    void (async () => {
      try {
        for await (const event of open(this.controller.signal)) {
          if ("delta" in event) this.add(event.delta);
          else if ("done" in event) {
            this.handoff = event.handoff;
            if (!this.text && event.text) this.add(event.text);
          } else if ("error" in event) {
            this.error = event.error;
            break;
          }
        }
      } catch (err) {
        if (!this.controller.signal.aborted) this.error = (err as Error).message;
      } finally {
        clearTimeout(timer);
        this.end();
        this.resolveFirst(this.text.trim().length > 0);
        this.onEnd();
      }
    })();
    return ready;
  }

  /** The sentences, as they complete; ends when the reply does. */
  async *pieces(): AsyncGenerator<string> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }

  abort() {
    this.controller.abort();
    this.end();
  }

  private add(delta: string) {
    if (!delta) return;
    this.text += delta;
    this.onText(this.text.trim());
    this.queue.push(...this.assembler.push(delta));
    if (this.text.trim()) this.resolveFirst(true);
    this.wake?.();
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.queue.push(...this.assembler.flush());
    this.wake?.();
  }

  private resolveFirst(ok: boolean) {
    const f = this.first;
    this.first = null;
    f?.(ok);
  }
}
