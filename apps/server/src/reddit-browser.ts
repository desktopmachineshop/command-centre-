import { REDDIT_BROWSER_JOB, RedditBrowserResult, type WorkerNode } from "@cc/core";
import { RedditPcUnavailable, RedditReadError } from "@cc/research";
import { type BrowserJobOptions, type BrowserJobs, PcOfflineError } from "@cc/social";
import type { WorkerService } from "./workers";

/**
 * Reddit browser mode's last hop (packages/social/src/adapters/reddit/browser.ts): a
 * `social.reddit.browser` job for a desktop worker with the `browser` capability, pinned to the
 * account's PC when it names one, awaited here so the approved action gets Reddit's answer.
 * - No such PC connected, or none takes the job within `pickupMs` (it is busy, e.g. capturing
 *   a video): PcOfflineError, which leaves a paced submission queued to try again.
 * - A post, reply or message is run at most once: if the PC drops mid-job it is not requeued,
 *   and the failure says to check Reddit before sending again.
 * - Read jobs (whoami, inbox) are deleted once read: they would fill the Devices page's job list
 *   every few minutes and keep other people's messages in the jobs table.
 */
export class WorkerBrowserJobs implements BrowserJobs {
  constructor(
    private readonly workers: Pick<WorkerService, "capableOnline" | "run">,
    private readonly store: { listNodes(): Promise<WorkerNode[]>; deleteJob(id: string): Promise<void> },
    private readonly options: { pickupMs?: number } = {},
  ) {}

  /** The account's PC, by node id or name (case-insensitive); undefined for any. */
  async node(ref: string | undefined): Promise<WorkerNode | undefined> {
    if (!ref) return undefined;
    const nodes = await this.store.listNodes();
    const node = nodes.find((n) => n.id === ref) ?? nodes.find((n) => n.name.toLowerCase() === ref.toLowerCase());
    if (!node) throw new Error(`There is no PC "${ref}" on the Devices page: set the Reddit account's PC to one listed there (its name), or leave it blank for any.`);
    return node;
  }

  /** "Studio PC", or "the PC" when any will do: for messages. */
  async pcName(ref: string | undefined): Promise<string> {
    const node = await this.node(ref).catch(() => undefined);
    return node?.name ?? (ref || "the PC");
  }

  async run(kind: string, payload: Record<string, unknown>, options: BrowserJobOptions): Promise<unknown> {
    const node = await this.node(options.node);
    const pc = node ? `${node.name}, the PC that posts to Reddit,` : "The PC that posts to Reddit";
    if (!this.workers.capableOnline(["browser"], node?.id)) {
      throw new PcOfflineError(`${pc} isn't connected (Devices page): turn it on and open the desktop app. Nothing was sent.`);
    }
    const minutes = Math.round(options.timeoutMs / 60_000) || 1;
    const outcome = await this.workers.run(
      { kind, requires: ["browser"], payload, targetNodeId: node?.id ?? null },
      { pickupMs: Math.min(this.options.pickupMs ?? 60_000, options.timeoutMs), timeoutMs: options.timeoutMs, once: options.once, signal: options.signal },
    );
    const check = options.once ? " Check Reddit before sending it again." : "";
    switch (outcome.kind) {
      case "not-picked-up":
        throw new PcOfflineError(`${pc} didn't take the job (it may be busy with another one, or just went offline). Nothing was sent.`);
      case "dropped":
        throw new Error(`${pc.replace(/,$/, "")} disconnected while it was working on Reddit, so whether it went out isn't known.${check}`);
      case "timed-out":
        throw new Error(`${pc.replace(/,$/, "")} didn't finish the Reddit job within ${minutes} minute${minutes === 1 ? "" : "s"}.${check}`);
      case "settled": {
        const { job } = outcome;
        if (!options.once) await this.store.deleteJob(job.id).catch(() => {});
        if (job.status === "failed") throw new Error(`The PC couldn't do the Reddit job: ${(job.result as { error?: string } | null)?.error ?? "no reason given"}.${check}`);
        return job.result;
      }
    }
  }
}

/** How long one read may take on the PC before the server reads another way. */
const READ_TIMEOUT_MS = 45_000;

/**
 * The agents' Reddit reads and searches through Dave's signed-in browser on his PC
 * (RedditReader's `browser` option): one `op: "read"` job per listing. Reddit's own answers (not
 * found, private, rate limited) are thrown as RedditReadError, as the reader throws them from
 * the server. Anything that means "this PC can't right now" (off, busy, signed out, blocked,
 * the browser wouldn't start) is RedditPcUnavailable, and the reader carries on from the server.
 */
export function redditPcRead(jobs: BrowserJobs, account: { node?: string; username?: string }) {
  return async (path: string, query: Record<string, string>): Promise<unknown> => {
    let raw: unknown;
    try {
      raw = await jobs.run(REDDIT_BROWSER_JOB, { op: "read", path, query, ...(account.username ? { username: account.username } : {}) }, { node: account.node, timeoutMs: READ_TIMEOUT_MS, once: false });
    } catch (err) {
      throw new RedditPcUnavailable((err as Error).message);
    }
    const parsed = RedditBrowserResult.safeParse(raw);
    if (!parsed.success) throw new RedditPcUnavailable("The PC sent back a Reddit result Command Centre couldn't read");
    const r = parsed.data;
    if (!r.ok) {
      if (r.code === "RATELIMIT") throw new RedditReadError(`Reddit is rate limiting the PC's session${r.retryAfterSec ? `; it asks for about ${Math.ceil(r.retryAfterSec)}s` : ""}. Carry on with what you have and try again later.`, 429);
      throw new RedditPcUnavailable(r.message);
    }
    const reason = (r.data as { reason?: unknown } | null)?.reason;
    if (r.status === 404) throw new RedditReadError(reason === "banned" ? "That subreddit is banned" : "Reddit has nothing there (check the subreddit, user or thread id)", 404);
    if (r.status === 403 && typeof reason === "string") throw new RedditReadError(`Reddit won't show that: the subreddit is ${reason === "gold_only" ? "for Reddit Premium members only" : reason}`, 403);
    if (r.status === 429) throw new RedditReadError("Reddit is rate limiting the PC's session (HTTP 429). Carry on with what you have and try again later.", 429);
    if (r.status < 200 || r.status >= 300 || r.data === undefined || r.data === null) throw new RedditPcUnavailable(`Reddit answered the PC with HTTP ${r.status}`);
    return r.data;
  };
}
