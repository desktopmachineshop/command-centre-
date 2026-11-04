import type { Proposal, Task } from "@cc/core";
import { plural, type SpeechToText, speakable, spokenUsd, type TextToSpeech, truncate } from "@cc/voice";
import { findVoice, type LocalSpeech, LocalTextToSpeech } from "@cc/voice/local";
import type { VerticalRegistry } from "@cc/verticals";
import type { BudgetService } from "../budget";
import { dayStart } from "../days";
import type { Store } from "../db/store";

/** One upcoming calendar entry, as a calendar integration provides it. */
export interface CalendarItem {
  title: string;
  /** ISO instant. */
  start: string;
  allDay?: boolean;
  location?: string;
}

/**
 * What the briefing needs from a calendar. The personal-assistant calendar
 * plugs in here (see `Overrides.voiceCalendar` in app.ts); without one the
 * briefing just leaves calendar out.
 */
export interface VoiceCalendar {
  upcoming(options: { now: Date; limit: number }): Promise<CalendarItem[]>;
}

export interface VoiceServiceOptions {
  stt?: SpeechToText;
  tts?: TextToSpeech;
  calendar?: VoiceCalendar;
  /** Self-hosted speech (open models): live transcription, and the voice when no TTS key is set. */
  local?: LocalSpeech | null;
  maxUploadBytes: number;
  maxSeconds: number;
  language: string;
  timezone: string;
  /** Texts up to this length are cached by /voice/speak. */
  cacheMaxChars?: number;
  cacheEntries?: number;
  now?: () => Date;
}

export interface Briefing {
  text: string;
  approvals: { count: number; items: { id: string; vertical: string; summary: string }[] };
  attention: { failedToday: number; deferred: number; running: number; items: { id: string; title: string; status: string }[] };
  cost: { todayUsd: number };
  calendar: CalendarItem[] | null;
}

export interface NextApproval {
  /** For a batch: its first item, with `batchId` and `batchSize`; deciding it decides the whole batch. */
  proposal: (Pick<Proposal, "id" | "vertical" | "actionType" | "summary" | "createdAt"> & { batchId?: string; batchSize?: number }) | null;
  position: number;
  remaining: number;
  text: string;
}

const ORDINALS = ["First", "Second", "Third", "Fourth", "Fifth"];
/** Approvals the briefing reads out by name; the rest are counted. */
const BRIEF_APPROVALS = 3;

/** Server-side speech plus the deterministic, speakable summaries Drive mode reads out. No LLM. */
export class VoiceService {
  private readonly cache = new Map<string, { audio: Uint8Array; mime: string }>();
  readonly options: VoiceServiceOptions;

  constructor(
    private readonly store: Store,
    private readonly verticals: VerticalRegistry,
    private readonly budget: BudgetService,
    options: VoiceServiceOptions,
  ) {
    // Kept as given (not copied), so getters for stt/tts/calendar are read at call time:
    // app.ts swaps them when the Accounts page changes the voice keys or the calendar.
    this.options = options;
  }

  get stt() {
    return this.options.stt;
  }
  private localTts: { speech: LocalSpeech; tts: LocalTextToSpeech } | null = null;

  /** The keyed TTS provider, else the self-hosted voice once its model is installed. */
  get tts(): TextToSpeech | undefined {
    if (this.options.tts) return this.options.tts;
    const local = this.options.local;
    if (!local?.ttsReady) return undefined;
    return this.localTtsFor(local);
  }

  private localTtsFor(local: LocalSpeech): LocalTextToSpeech {
    if (this.localTts?.speech !== local) this.localTts = { speech: local, tts: new LocalTextToSpeech(local) };
    return this.localTts.tts;
  }

  /** Live (streaming) transcription is self-hosted; ready once its model is installed. */
  get streaming(): boolean {
    return Boolean(this.options.local?.asrReady);
  }

  /** Loads the self-hosted engines ahead of use. */
  async warm(): Promise<void> {
    await this.options.local?.warm();
  }

  /** e.g. "2 approvals waiting", for the voice front's context. */
  async pendingLine(): Promise<string> {
    const pending = await this.store.listProposals({ status: "pending", limit: 200 });
    return pending.length ? `${plural(pending.length, "approval")} waiting` : "no approvals waiting";
  }

  config() {
    const { stt, maxUploadBytes, maxSeconds, language } = this.options;
    const tts = this.tts;
    const local = this.options.local;
    return {
      stt: stt ? { provider: stt.provider, model: stt.model, streaming: this.streaming } : this.streaming ? { provider: "local", model: "kroko", streaming: true } : null,
      tts: tts ? { provider: tts.provider, model: tts.model, voice: tts.defaultVoice } : null,
      local: local ? { stt: local.status.asr, tts: local.status.tts, voices: true } : null,
      maxUploadBytes,
      maxSeconds,
      language,
      calendar: Boolean(this.options.calendar),
    };
  }

  /** Synthesizes `text`, from the cache for short phrases ("Working on it", confirmations). */
  /** The self-hosted voices that can be chosen (empty without self-hosted speech). */
  voices() {
    const local = this.options.local;
    if (!local) return { default: this.tts?.defaultVoice ?? null, voices: [] };
    return {
      default: this.options.tts ? null : local.voice,
      voices: local.voices().map((v) => ({ id: v.id, label: v.label, description: v.description, tier: v.tier, sizeMb: v.model.mb, status: v.status, error: v.error ?? null, isDefault: v.isDefault })),
    };
  }

  /** Starts downloading a self-hosted voice; resolves once it's ready. */
  installVoice(id: string): Promise<void> {
    const local = this.options.local;
    if (!local) return Promise.reject(new Error("self-hosted speech is off"));
    return local.installVoice(id);
  }

  /**
   * Synthesizes `text`, from the cache for short phrases ("On it", confirmations). `voice`: a
   * self-hosted voice id ("piper:jenny_dioco") speaks with that voice, even when a keyed
   * provider is the default; one not downloaded yet starts downloading and the default speaks
   * meanwhile, unless `fallback` is false (VoiceNotInstalledError).
   */
  async speak(text: string, voice?: string, opts: { fallback?: boolean } = {}): Promise<{ audio: Uint8Array; mime: string; cached: boolean; voice?: string }> {
    const local = this.options.local;
    const localVoice = voice && local && findVoice(voice) ? voice : undefined;
    const tts: TextToSpeech | undefined = localVoice ? this.localTtsFor(local!) : this.tts;
    if (!tts) throw new Error("no TTS provider configured");
    const key = `${tts.provider}:${tts.model}:${voice ?? tts.defaultVoice}:${text}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return { ...hit, cached: true };
    }
    const started = Date.now();
    const result = await (tts as LocalTextToSpeech).synthesize(text, { voice, format: "mp3", language: this.options.language, fallback: opts.fallback });
    const { audio, mime } = result;
    if (tts.provider === "local" && Date.now() - started > 1500) console.log(`[voice] slow synthesis: ${Date.now() - started} ms for ${text.length} chars`);
    // A fallback (the chosen voice still downloading) isn't cached under the chosen voice.
    const fellBack = Boolean(voice && result.voice && result.voice !== voice);
    if (!fellBack && text.length <= (this.options.cacheMaxChars ?? 300)) {
      this.cache.set(key, { audio, mime });
      while (this.cache.size > (this.options.cacheEntries ?? 200)) this.cache.delete(this.cache.keys().next().value!);
    }
    return { audio, mime, cached: false, voice: result.voice };
  }

  private verticalName(id: string) {
    return this.verticals.get(id)?.name ?? id;
  }

  async briefing(): Promise<Briefing> {
    const now = this.options.now?.() ?? new Date();
    const since = dayStart(this.budget.today(), this.options.timezone);
    const pending = await this.store.listProposals({ status: "pending", limit: 200 });
    const failed = (await this.store.listTasks({ status: "failed", limit: 100 })).filter((t) => new Date(t.updatedAt) >= since);
    const deferred = await this.store.listTasks({ status: "deferred", limit: 100 });
    const running = await this.store.listTasks({ status: "running", limit: 100 });
    const costTodayUsd = await this.store.costSince(since);
    let calendar: CalendarItem[] | null = null;
    if (this.options.calendar) {
      calendar = await this.options.calendar.upcoming({ now, limit: 3 }).catch((err) => {
        console.error("[voice] calendar", err);
        return null;
      });
    }

    const parts: string[] = [];
    const ordered = oldestFirst(pending);
    if (ordered.length === 0) parts.push("Nothing is waiting for approval.");
    else {
      parts.push(`You have ${plural(ordered.length, "approval")} waiting.`);
      ordered.slice(0, BRIEF_APPROVALS).forEach((p, i) => {
        const lead = ordered.length === 1 ? "It's" : `${ORDINALS[i]},`;
        parts.push(`${lead} for ${this.verticalName(p.vertical)}: ${short(p.summary)}`);
      });
      if (ordered.length > BRIEF_APPROVALS) parts.push(`And ${ordered.length - BRIEF_APPROVALS} more.`);
    }

    const attention = [...failed, ...deferred];
    if (failed.length) {
      parts.push(`${plural(failed.length, "task")} failed today${failed.length === 1 ? `: ${short(await this.taskTitle(failed[0]!))}` : "."}`);
    }
    if (deferred.length) parts.push(`${plural(deferred.length, "task")} ${deferred.length === 1 ? "is" : "are"} held back by the daily budget.`);
    if (running.length) parts.push(`${plural(running.length, "task")} ${running.length === 1 ? "is" : "are"} still running.`);
    if (!failed.length && !deferred.length && !ordered.length) parts.push("No tasks need your attention.");
    parts.push(`Today's spend is ${spokenUsd(costTodayUsd)}.`);
    if (calendar?.length) {
      const items = calendar.map((c) => `${this.spokenWhen(c, now)}, ${short(c.title, 80)}`);
      parts.push(`Next on your calendar: ${items.join("; then ")}.`);
    }

    return {
      text: parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(" "),
      approvals: { count: ordered.length, items: ordered.slice(0, BRIEF_APPROVALS).map((p) => ({ id: p.id, vertical: p.vertical, summary: p.summary })) },
      attention: {
        failedToday: failed.length,
        deferred: deferred.length,
        running: running.length,
        items: await Promise.all(attention.slice(0, 5).map(async (t) => ({ id: t.id, title: await this.taskTitle(t), status: t.status }))),
      },
      cost: { todayUsd: costTodayUsd },
      calendar,
    };
  }

  /**
   * The next pending proposal (oldest first), skipping `skip`, described for reading aloud. A
   * batch counts as one approval, read out with every item (up to BATCH_READ_ITEMS), and is
   * skipped by its first item's id.
   */
  async nextApproval(skip: string[] = []): Promise<NextApproval> {
    const units = approvalUnits(oldestFirst(await this.store.listProposals({ status: "pending", limit: 200 })));
    const left = units.filter((u) => !skip.includes(u[0]!.id));
    const unit = left[0];
    if (!unit) {
      return {
        proposal: null,
        position: 0,
        remaining: 0,
        text: units.length ? "That's all the approvals. Say read approvals to start again." : "Nothing is waiting for approval.",
      };
    }
    const next = unit[0]!;
    const position = units.indexOf(unit) + 1;
    const { id, vertical, actionType, summary, createdAt } = next;
    if (next.batchId) {
      const read = unit.slice(0, BATCH_READ_ITEMS).map((p, i) => `${i + 1}: ${short(p.summary, 120)}${typeof p.payload.to === "string" ? `, to ${short(p.payload.to, 60)}` : ""}.`);
      const more = unit.length > BATCH_READ_ITEMS ? ` And ${unit.length - BATCH_READ_ITEMS} more, listed in the app.` : "";
      const kinds = [...new Set(unit.map((p) => spokenAction(p.actionType)))].join(" and ");
      const text = [
        `Approval ${position} of ${units.length}, for ${this.verticalName(vertical)}: a batch of ${unit.length}, ${kinds}.`,
        `${short(next.batchSummary ?? summary, 220)}.`,
        ...read,
        `${more.trim()} Say approve to approve all ${unit.length}, reject to reject all ${unit.length}, or next.`.trim(),
      ].join(" ");
      return { proposal: { id, vertical, actionType, summary: next.batchSummary ?? summary, createdAt, batchId: next.batchId, batchSize: unit.length }, position, remaining: left.length - 1, text };
    }
    const to = typeof next.payload.to === "string" ? ` To ${short(next.payload.to, 60)}.` : "";
    const text = [
      `Approval ${position} of ${units.length}, for ${this.verticalName(vertical)}: ${spokenAction(actionType)}.`,
      `${short(summary, 220)}.${to}`,
      "Say approve, reject, or next.",
    ].join(" ");
    return { proposal: { id, vertical, actionType, summary, createdAt }, position, remaining: left.length - 1, text };
  }

  private async taskTitle(task: Task): Promise<string> {
    const event = await this.store.getEvent(task.eventId);
    return event?.title ?? task.prompt.slice(0, 120);
  }

  /** "today at 3 pm", "tomorrow at 9:30 am", "Monday", "today, all day". */
  private spokenWhen(item: CalendarItem, now: Date): string {
    const tz = this.options.timezone;
    const start = new Date(item.start);
    const day = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
    const diff = Math.round((Date.parse(day(start)) - Date.parse(day(now))) / 86_400_000);
    const when = diff === 0 ? "today" : diff === 1 ? "tomorrow" : new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" }).format(start);
    if (item.allDay) return `${when}, all day`;
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
      .format(start)
      .replace(":00", "")
      .replace(/\s?([ap])\.?m\.?/i, " $1m");
    return `${when} at ${time}`;
  }
}

/** `proposals` come newest first from the database (microsecond order); reversing first keeps that order for same-millisecond ties. */
function oldestFirst(proposals: Proposal[]): Proposal[] {
  return [...proposals].reverse().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Batch items read aloud; the rest are counted. */
const BATCH_READ_ITEMS = 20;

/** Pending proposals as approval units, in order: each batch's items together (at its first item's place), others alone. */
export function approvalUnits(proposals: Proposal[]): Proposal[][] {
  const units: Proposal[][] = [];
  const batches = new Map<string, Proposal[]>();
  for (const p of proposals) {
    if (!p.batchId) {
      units.push([p]);
      continue;
    }
    const unit = batches.get(p.batchId);
    if (unit) unit.push(p);
    else {
      const fresh = [p];
      batches.set(p.batchId, fresh);
      units.push(fresh);
    }
  }
  return units;
}

/** "email.reply" → "email reply", "social.campaign" → "social campaign". */
export function spokenAction(actionType: string): string {
  return actionType.replace(/[._-]+/g, " ").trim();
}

function short(text: string, max = 140): string {
  return truncate(speakable(text, { maxChars: 10_000 }), max, "").replace(/\.$/, "");
}
