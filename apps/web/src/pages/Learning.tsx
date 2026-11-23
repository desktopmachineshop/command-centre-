import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Api, LearningStats, LearningSuggestion, LearningTrack, LearningView, Lesson, LessonAudio, LessonProgress, Narration, VoiceConfig, VoiceList } from "../api";
import { Icon } from "../icons";
import { useLessonPlayer } from "../learning/player";
import { localPlace, progressPercent, startingPlace, useLessonAudio } from "../learning/global-player";
import { chapterAt, clock, SPEEDS } from "../learning/recording";
import { estimateMarks, lessonScript, minutesLeft, partAt, type Script } from "../learning/script";
import { type LiveFeed, useLoad } from "../live";
import { Markdown } from "../markdown";
import { go, useRouteQuery } from "../router";

const lessonHref = (path: string, listen = false) => `learning/${encodeURIComponent(path)}${listen ? "?listen=1" : ""}`;
const dayLabel = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));
const hours = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`);

/** Learning: today's lesson, picking another or asking for one, the scoreboard, and every lesson. */
export function Learning({ api, feed, path }: { api: Api; feed: LiveFeed; path?: string }) {
  // A lesson the coach was asked for appears when its task finishes.
  const view = useLoad(api.learning, feed, (m) => m.type === "task.updated" && m.task.status !== "running");
  if (path) return <LessonPage api={api} path={path} onChange={view.reload} tracks={view.data?.tracks ?? []} />;
  return (
    <section className="learning-page">
      <div className="row between">
        <h2>Learning</h2>
        <a className="small" href={`#/brain/${encodeURIComponent(view.data?.topicsPath ?? "learning/topics.md")}`}>
          Topic map
        </a>
      </div>
      {view.error && <p className="error">{view.error}</p>}
      {view.data && (
        <>
          <TodayCard view={view.data} />
          <Scoreboard stats={view.data.stats} />
          <Choose api={api} view={view.data} onAsked={view.reload} />
          <Library view={view.data} />
          <NarratorCard api={api} narration={view.data.narration} onChange={view.reload} />
        </>
      )}
      {!view.data && !view.error && <p className="muted">Loading…</p>}
    </section>
  );
}

/** How far through a lesson Dave is: a tick once done, else the percentage and a thin bar. */
export function LessonProgressBadge({ lesson, bar = true }: { lesson: Pick<Lesson, "status" | "completedMode" | "percent">; bar?: boolean }) {
  if (lesson.status === "done") {
    return (
      <span className="done-mark">
        <Icon name="check" size={14} /> {lesson.completedMode === "listen" ? "Listened" : "Read"}
      </span>
    );
  }
  const pct = lesson.percent ?? 0;
  if (pct <= 0) return <span className="muted small">Not started</span>;
  return (
    <span className="lesson-pct" title={`${pct}% done`}>
      {bar && (
        <span className="pct-bar" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
      <span className="small">{pct}%</span>
    </span>
  );
}

function TrackChip({ track, tracks }: { track: string; tracks: LearningTrack[] }) {
  return <span className="track-chip">{tracks.find((t) => t.id === track)?.name ?? track}</span>;
}

function TodayCard({ view }: { view: LearningView }) {
  const l = view.todays;
  if (!l) {
    const next = view.suggestions.requested[0] ?? view.suggestions.fromWork?.[0] ?? view.suggestions.upNext[0];
    return (
      <article className="card learning-today">
        <p className="muted small">Today's lesson</p>
        <h3>No lesson ready yet</h3>
        <p className="small">
          The coach writes one every morning at 05:40.{next ? ` Next up: ${next.title}.` : ""} Pick a topic below to have one written now.
        </p>
      </article>
    );
  }
  return (
    <article className="card learning-today">
      <p className="muted small">{l.created === view.today ? "Today's lesson" : `Waiting since ${dayLabel(l.created)}`}</p>
      <h3>{l.title}</h3>
      <p className="row wrap small lesson-meta">
        <TrackChip track={l.track} tracks={view.tracks} />
        <span className="muted nowrap">
          {l.listenMinutes} min listen · {l.readMinutes} min read
        </span>
        <LessonProgressBadge lesson={l} />
      </p>
      {l.summary && <p>{l.summary}</p>}
      <div className="row learning-actions">
        <button className="primary big" onClick={() => go(lessonHref(l.path, true))}>
          <Icon name="play" /> {(l.percent ?? 0) > 0 ? "Continue" : "Listen"}
        </button>
        <button className="big" onClick={() => go(lessonHref(l.path))}>
          <Icon name="learn" /> Read
        </button>
      </div>
    </article>
  );
}

/** Stat tiles, the last 12 weeks, the tracks and the badges. One hue throughout: labels carry identity. */
function Scoreboard({ stats }: { stats: LearningStats }) {
  const maxWeek = Math.max(1, ...stats.weeks.map((w) => w.completed));
  const maxTrack = Math.max(1, ...stats.byTrack.map((t) => t.completed));
  return (
    <article className="card scoreboard" aria-label="Scoreboard">
      <h3>Scoreboard</h3>
      <div className="stat-tiles">
        <div className="stat-tile">
          <span className="stat-value">{stats.streak}</span>
          <span className="stat-label">day streak{stats.doneToday ? "" : stats.streak ? " (today's to do)" : ""}</span>
          <span className="stat-sub muted">best {stats.bestStreak}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{stats.completed}</span>
          <span className="stat-label">lessons done</span>
          <span className="stat-sub muted">
            {stats.listened} listened · {stats.read} read
          </span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{hours(stats.minutes)}</span>
          <span className="stat-label">learning time</span>
          <span className="stat-sub muted">{stats.averageRating ? `rated ${stats.averageRating}/5` : `${stats.ready} waiting`}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-value">{stats.thisWeek}/7</span>
          <span className="stat-label">this week</span>
          <span className="stat-sub muted">{stats.ready} waiting</span>
        </div>
      </div>

      <h4 className="small">Lessons a week</h4>
      <div className="week-bars" role="img" aria-label={`Lessons per week, last 12 weeks: ${stats.weeks.map((w) => w.completed).join(", ")}`}>
        {stats.weeks.map((w) => (
          <div key={w.start} className="week-bar" title={`Week of ${dayLabel(w.start)}: ${w.completed} lesson${w.completed === 1 ? "" : "s"}, ${w.minutes} min`}>
            <span className="week-fill" style={{ height: `${(w.completed / maxWeek) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="row between small muted week-axis">
        <span>{dayLabel(stats.weeks[0]!.start)}</span>
        <span>this week</span>
      </div>

      <h4 className="small">By track</h4>
      <ul className="track-bars">
        {stats.byTrack.map((t) => (
          <li key={t.track} title={`${t.name}: ${t.completed} lessons, ${t.minutes} min`}>
            <span className="track-name small">{t.name}</span>
            <span className="track-bar">
              <span className="track-fill" style={{ width: `${(t.completed / maxTrack) * 100}%` }} />
            </span>
            <span className="small track-count">{t.completed}</span>
          </li>
        ))}
      </ul>

      <h4 className="small">Badges</h4>
      <ul className="badges">
        {stats.badges.map((b) => (
          <li key={b.id} className={b.earned ? "earned" : ""} title={b.detail}>
            <Icon name={b.earned ? "check" : "clock"} size={14} />
            <span>{b.label}</span>
            {!b.earned && <span className="muted small">{b.detail}</span>}
          </li>
        ))}
      </ul>
    </article>
  );
}

/** Today's alternatives (requested and up next), and a box to ask for any topic. */
function Choose({ api, view, onAsked }: { api: Api; view: LearningView; onAsked: () => void }) {
  const [asked, setAsked] = useState<Record<string, string | null>>({});
  const [topic, setTopic] = useState("");
  const [track, setTrack] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const ask = async (s: { title: string; track?: string }) => {
    setErr(null);
    try {
      const { taskId } = await api.requestLesson(s.title, s.track);
      setAsked((a) => ({ ...a, [s.title.toLowerCase()]: taskId }));
      onAsked();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (topic.trim().length < 2) return;
    await ask({ title: topic.trim(), track: track || undefined });
    setTopic("");
  };
  const seen = new Set<string>();
  const list: (LearningSuggestion & { from: string | null })[] = [];
  for (const [items, from] of [
    [view.suggestions.requested, "requested"],
    [view.suggestions.fromWork ?? [], "from your work"],
    [view.suggestions.upNext, null],
  ] as const) {
    for (const s of items) {
      if (seen.has(s.title.toLowerCase())) continue;
      seen.add(s.title.toLowerCase());
      list.push({ ...s, from });
    }
  }
  return (
    <article className="card">
      <h3>Pick another topic</h3>
      <p className="muted small">The coach writes a 30-minute lesson on it now (a few minutes). It appears here when it's ready.</p>
      {list.length > 0 && (
        <ul className="list suggestions">
          {list.map((s) => {
            const key = s.title.toLowerCase();
            const sent = key in asked;
            return (
              <li key={key} className="item static">
                <div className="row between">
                  <span className="row">
                    <TrackChip track={s.track} tracks={view.tracks} />
                    {s.from && <span className="muted small">{s.from}</span>}
                  </span>
                  {sent ? (
                    asked[key] ? (
                      <a className="small" href={`#/task/${asked[key]}`}>
                        Being written…
                      </a>
                    ) : (
                      <span className="small muted">Asked</span>
                    )
                  ) : (
                    <button onClick={() => void ask(s)}>Make this lesson</button>
                  )}
                </div>
                <p className="title">{s.title}</p>
                {s.why && <p className="small muted">{s.why}</p>}
              </li>
            );
          })}
        </ul>
      )}
      <form className="row ask-topic" onSubmit={(e) => void submit(e)}>
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Teach me about…" aria-label="Topic to learn" maxLength={300} />
        <select value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Track">
          <option value="">Any track</option>
          {view.tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button className="primary" disabled={topic.trim().length < 2}>
          Ask
        </button>
      </form>
      {err && <p className="error">{err}</p>}
    </article>
  );
}

function Library({ view }: { view: LearningView }) {
  const [track, setTrack] = useState("");
  // What's still to do comes first; All and Done are a tap away.
  const [status, setStatus] = useState<"" | "ready" | "done">("ready");
  const shown = view.lessons.filter((l) => (!track || l.track === track) && (!status || l.status === status));
  return (
    <article className="card">
      <h3>All lessons</h3>
      <div className="row wrap filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="">All</option>
          <option value="ready">To do</option>
          <option value="done">Done</option>
        </select>
        <select value={track} onChange={(e) => setTrack(e.target.value)} aria-label="Track">
          <option value="">Every track</option>
          {view.tracks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 && <p className="muted small">{view.lessons.length ? (status === "ready" && !track ? "Nothing to do: every lesson is done. Choose All to see them." : "None match.") : "No lessons yet. The first arrives tomorrow morning, or ask for one above."}</p>}
      <ul className="list">
        {shown.map((l) => (
          <li key={l.path} className="item" onClick={() => go(lessonHref(l.path))}>
            <div className="row between small">
              <span className="row">
                <TrackChip track={l.track} tracks={view.tracks} />
                <span className="muted">{dayLabel(l.created)}</span>
              </span>
              {l.status === "done" || (l.percent ?? 0) > 0 ? <LessonProgressBadge lesson={l} /> : <span className="muted">{l.listenMinutes} min</span>}
            </div>
            <p className="title">{l.title}</p>
            {l.summary && <p className="small clip">{l.summary}</p>}
          </li>
        ))}
      </ul>
    </article>
  );
}

// ---------- the narrator ----------

/** "kokoro:bf_emma" → "Emma (Kokoro)", for a voice the server doesn't list right now. Pure. */
export function prettyVoice(id: string): string {
  const [family = "", name = id] = id.includes(":") ? id.split(":") : ["", id];
  const bare = name.replace(/^[ab][fm]_/, "").replace(/_/g, " ");
  const cap = (t: string) => t.replace(/\b\w/g, (c) => c.toUpperCase());
  return family ? `${cap(bare)} (${cap(family)})` : cap(bare);
}

/**
 * Who records the lessons. The server's own voices are free and have no limits; "most natural"
 * ones (Kokoro) take a little longer to record, which doesn't matter for a lesson recorded at dawn.
 */
function NarratorCard({ api, narration, onChange }: { api: Api; narration: Narration | null; onChange: () => void }) {
  const [list, setList] = useState<VoiceList | null>(null);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    api.voices().then(setList).catch(() => setList(null));
    api.voiceConfig().then(setConfig).catch(() => setConfig(null));
    return () => audio.current?.pause();
  }, [api]);
  if (!narration) return null;
  const voices = list?.voices ?? [];
  const keyed = config?.tts && config.tts.provider !== "local";
  const chosen = voices.find((v) => v.id === narration.narrator);
  const choose = async (id: string) => {
    setNote(null);
    try {
      await api.setNarrator(id);
      const v = voices.find((x) => x.id === id);
      if (v && v.status !== "ready" && v.tier !== "elevenlabs") void api.installVoice(id).then(setList).catch(() => {});
      setNote(
        v?.tier === "elevenlabs" || (!v && keyed)
          ? "New lessons will be recorded with this voice. It's a paid voice: a 30-minute lesson is about 27,000 characters of speech."
          : "New lessons will be recorded with this voice (free, on the server). To re-record a lesson, open it and choose Re-record.",
      );
      onChange();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const preview = async () => {
    audio.current?.pause();
    setPlaying(true);
    setNote(null);
    try {
      const blob = await api.speak("Welcome back. Today we're looking at how EtherCAT keeps a hundred axes in step, and why it matters on the factory floor.", narration.narrator || undefined, { fallback: false });
      const a = new Audio(URL.createObjectURL(blob));
      audio.current = a;
      a.onended = () => setPlaying(false);
      await a.play();
    } catch (e) {
      setPlaying(false);
      setNote((e as Error).message.includes("downloading") || (e as Error).message.includes("409") ? "That voice is still downloading. Try again in a minute." : (e as Error).message);
    }
  };
  const group = (tier: string) => voices.filter((v) => v.tier === tier);
  return (
    <article className="card narrator">
      <h3>Narrator</h3>
      <p className="muted small">
        Each lesson is recorded once, before you need it: whole sentences with natural pauses, terms said the way{" "}
        <a href={`#/brain/${encodeURIComponent("learning/pronunciation.md")}`}>the pronunciation list</a> says, and every sentence checked by ear.
      </p>
      <div className="row wrap narrator-row">
        <select value={narration.narrator} onChange={(e) => void choose(e.target.value)} aria-label="Narrator">
          {keyed && <option value="">{`Server voice (${config!.tts!.provider}, paid)`}</option>}
          {group("natural").length > 0 && (
            <optgroup label="Most natural: free, on the server">
              {group("natural").map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.description.split(" · ")[0]}
                  {v.status === "ready" ? "" : v.status === "installing" ? " (downloading…)" : ` (downloads ${v.sizeMb} MB)`}
                </option>
              ))}
            </optgroup>
          )}
          {group("fast").length > 0 && (
            <optgroup label="Fast: free, less natural">
              {group("fast").map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.description.split(" · ")[0]}
                </option>
              ))}
            </optgroup>
          )}
          {group("elevenlabs").length > 0 && (
            <optgroup label="ElevenLabs (paid)">
              {group("elevenlabs").map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </optgroup>
          )}
          {!voices.some((v) => v.id === narration.narrator) && narration.narrator && <option value={narration.narrator}>{prettyVoice(narration.narrator)}</option>}
        </select>
        <button type="button" onClick={() => (playing ? (audio.current?.pause(), setPlaying(false)) : void preview())}>
          {playing ? "Stop" : "Preview"}
        </button>
      </div>
      {chosen && chosen.status !== "ready" && chosen.tier !== "elevenlabs" && <p className="muted small">{chosen.label} is downloading ({chosen.sizeMb} MB); recordings wait for it.</p>}
      {!narration.available && <p className="error small">Recording is off: {narration.reason}. Lessons are read live instead.</p>}
      {narration.current && (
        <p className="muted small" role="status">
          Recording {narration.current.total ? `${Math.round((narration.current.done / narration.current.total) * 100)}%` : "…"}
          {narration.queued.length ? `, ${narration.queued.length} more waiting` : ""}.
        </p>
      )}
      {note && <p className="muted small">{note}</p>}
    </article>
  );
}

// ---------- one lesson ----------

function LessonPage({ api, path, onChange, tracks }: { api: Api; path: string; onChange: () => void; tracks: LearningTrack[] }) {
  const [data, setData] = useState<{ lesson: Lesson; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [narration, setNarration] = useState<Narration | null>(null);
  const [progress, setProgress] = useState<LessonProgress | null | undefined>(undefined);
  const load = () =>
    api
      .lesson(path)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setData(null);
    setProgress(undefined);
    void load();
    api.voiceConfig().then(setConfig).catch(() => setConfig(null));
    api.narration().then(setNarration).catch(() => setNarration(null));
    api.progress(path).then(setProgress).catch(() => setProgress(null));
  }, [path]);
  // While this lesson is being recorded (or waits to be), follow it, and load the recording when it's done.
  const busy = narration && (narration.current?.path === path || narration.queued.includes(path));
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => {
      void api.narration().then((n) => {
        setNarration(n);
        if (n && n.current?.path !== path && !n.queued.includes(path)) void load();
      });
    }, 4000);
    return () => clearInterval(t);
  }, [busy, path]);
  if (error) return <p className="error">{error}</p>;
  if (!data || progress === undefined) return <p className="muted">Loading…</p>;
  const record = async () => setNarration(await api.recordLesson(path));
  return (
    <LessonView
      key={path}
      api={api}
      config={config}
      narration={narration}
      record={record}
      lesson={data.lesson}
      body={data.body}
      progress={progress}
      tracks={tracks}
      onChange={() => void load().then(onChange)}
    />
  );
}

type Listened = { current: () => number };
/** What the listening card tells the page: the part being spoken, and how to play from a part. */
type Sync = { speaking: number | null; playing: boolean; playFrom: ((part: number) => void) | null; listenedPart: number | null; listenedAt: number };

export { startingPlace };

function LessonView({
  api,
  config,
  narration,
  record,
  lesson,
  body,
  progress,
  tracks,
  onChange,
}: {
  api: Api;
  config: VoiceConfig | null;
  narration: Narration | null;
  record: () => Promise<void>;
  lesson: Lesson;
  body: string;
  progress: LessonProgress | null;
  tracks: LearningTrack[];
  onChange: () => void;
}) {
  const opened = useRef(Date.now());
  const listened: Listened = useRef(() => 0);
  const stop = useRef<() => void>(() => {});
  const [rating, setRating] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const script = useMemo(() => lessonScript(body, lesson.title), [body, lesson.title]);
  const [sync, setSync] = useState<Sync>({ speaking: null, playing: false, playFrom: null, listenedPart: null, listenedAt: 0 });
  // Where Dave read to (a part), kept here as he scrolls and saved to the server when he settles.
  const [readPart, setReadPart] = useState<{ part: number; at: number } | null>(
    progress?.readPart != null ? { part: progress.readPart, at: progress.readAt ? Date.parse(progress.readAt) : 0 } : null,
  );
  const [scrollTo, setScrollTo] = useState<{ part: number; n: number } | null>(null);
  const jumpToText = (part: number) => setScrollTo((s) => ({ part, n: (s?.n ?? 0) + 1 }));

  const complete = async (mode: "read" | "listen") => {
    setErr(null);
    const spent = mode === "listen" ? listened.current() : Math.round((Date.now() - opened.current) / 60_000);
    try {
      stop.current();
      // Under five minutes is a skim or a resumed session: credit the lesson's own length.
      await api.completeLesson(lesson.path, mode, { ...(spent >= 5 ? { minutes: Math.min(spent, 240) } : {}), ...(rating ? { rating } : {}) });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const recording = narration?.current?.path === lesson.path ? narration.current : null;
  const waiting = narration?.queued.includes(lesson.path);
  const sectionTitle = (part: number) => script.sections[script.parts[part]?.section ?? 0]?.title ?? lesson.title;

  // Whispersync: offer to carry the place over when one is clearly ahead of the other.
  const listenedPart = sync.listenedPart;
  const readAhead = readPart && listenedPart !== null && readPart.at > sync.listenedAt && readPart.part > listenedPart + 1 && !sync.playing;
  const listenAhead =
    !sync.playing && listenedPart !== null && (readPart !== null ? sync.listenedAt > readPart.at && listenedPart > readPart.part + 1 : listenedPart > 1);

  return (
    <section className="lesson-page">
      <a className="small back-link" href="#/learning">
        <Icon name="back" size={14} /> Learning
      </a>
      <header>
        <h2>{lesson.title}</h2>
        <p className="row small">
          <TrackChip track={lesson.track} tracks={tracks} />
          <span className="muted">
            {dayLabel(lesson.created)} · {lesson.listenMinutes} min listen · {lesson.readMinutes} min read
          </span>
          <LessonProgressBadge lesson={{ ...lesson, percent: lesson.percent ?? progressPercent(lesson, progress, script.parts.length) }} />
        </p>
      </header>

      {lesson.audio ? (
        <RecordingCard
          key={lesson.audio.id}
          api={api}
          audio={lesson.audio}
          lesson={lesson}
          script={script}
          serverProgress={progress}
          listened={listened}
          stop={stop}
          onSync={setSync}
          onEnded={onChange}
          onFindPlace={jumpToText}
          rerecord={narration?.available ? record : null}
          rerecording={Boolean(recording || waiting)}
          progress={recording}
        />
      ) : (
        <LiveCard
          api={api}
          config={config}
          lesson={lesson}
          script={script}
          narrator={narration?.narrator ?? ""}
          listened={listened}
          stop={stop}
          onSync={setSync}
          onFinished={() => void complete("listen")}
          status={
            recording
              ? `Being recorded: ${recording.total ? Math.round((recording.done / recording.total) * 100) : 0}%. Until then, the live voice reads it.`
              : waiting
                ? "Waiting to be recorded. Until then, the live voice reads it."
                : narration?.available
                  ? "Not recorded yet. The live voice reads it meanwhile."
                  : null
          }
          record={narration?.available && !recording && !waiting ? record : null}
        />
      )}

      {(readAhead || listenAhead) && (
        <div className="card sync-bar row wrap" role="status">
          <Icon name="refresh" size={16} />
          {readAhead && readPart && sync.playFrom && (
            <button className="small" onClick={() => sync.playFrom?.(readPart.part)}>
              Listen from where you read: {sectionTitle(readPart.part)}
            </button>
          )}
          {listenAhead && listenedPart !== null && (
            <button className="small" onClick={() => jumpToText(listenedPart)}>
              Read from where you listened: {sectionTitle(listenedPart)}
            </button>
          )}
        </div>
      )}

      <ReadingView
        api={api}
        path={lesson.path}
        script={script}
        sync={sync}
        scrollTo={scrollTo}
        onRead={(part) => setReadPart({ part, at: Date.now() })}
      />

      <article className="card lesson-done">
        {lesson.status === "done" ? (
          <div className="row between">
            <span className="done-mark">
              <Icon name="check" /> {lesson.completedMode === "listen" ? "Listened" : "Read"}
              {lesson.completedAt ? ` on ${dayLabel(lesson.completedAt.slice(0, 10))}` : ""}
              {lesson.minutesSpent ? ` · ${lesson.minutesSpent} min` : ""}
              {lesson.rating ? ` · ${"★".repeat(lesson.rating)}` : ""}
            </span>
            <button className="small" onClick={() => void api.reopenLesson(lesson.path).then(onChange)}>
              Not done
            </button>
          </div>
        ) : (
          <>
            <h3>Finished?</h3>
            <div className="row stars" role="radiogroup" aria-label="How useful was it?">
              <span className="small muted">How useful?</span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} role="radio" aria-checked={rating === n} aria-label={`${n} of 5`} className={`star ${rating && n <= rating ? "on" : ""}`} onClick={() => setRating(n)}>
                  ★
                </button>
              ))}
            </div>
            <div className="row learning-actions">
              <button className="primary" onClick={() => void complete("read")}>
                Mark as read
              </button>
              <button onClick={() => void complete("listen")}>Mark as listened</button>
            </div>
          </>
        )}
        {err && <p className="error">{err}</p>}
      </article>
    </section>
  );
}

/**
 * The lesson's text, block by block, kept in step with the voice: the paragraph being spoken is
 * highlighted (and followed, unless Dave turns that off or is scrolling himself), a tap on a
 * paragraph offers to listen from there, and where he reads to is saved once he stops scrolling.
 */
function ReadingView({
  api,
  path,
  script,
  sync,
  scrollTo,
  onRead,
}: {
  api: Api;
  path: string;
  script: Script;
  sync: Sync;
  scrollTo: { part: number; n: number } | null;
  onRead: (part: number) => void;
}) {
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const userScrolled = useRef(0);
  const autoScrolled = useRef(0);

  const scrollToPart = (part: number, smooth = true) => {
    const el = root.current?.querySelector(`[data-part="${part}"]`);
    if (!el) return;
    autoScrolled.current = Date.now();
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  };

  // Follow the voice: when the spoken part changes, bring it into view (not while Dave is scrolling).
  useEffect(() => {
    if (!follow || !sync.playing || sync.speaking === null) return;
    if (Date.now() - userScrolled.current < 6000) return;
    scrollToPart(sync.speaking);
  }, [sync.speaking, sync.playing, follow]);
  useEffect(() => {
    if (scrollTo) scrollToPart(scrollTo.part);
  }, [scrollTo]);

  // Where Dave reads to: the first spoken part at the top of the screen, saved when he settles.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (Date.now() - autoScrolled.current > 1200) userScrolled.current = Date.now();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (sync.playing || Date.now() - autoScrolled.current < 1500) return;
        const blocks = [...(root.current?.querySelectorAll<HTMLElement>("[data-part]") ?? [])];
        const top = blocks.find((b) => b.getBoundingClientRect().bottom > 90);
        const part = top ? Number(top.dataset.part) : null;
        if (part === null || Number.isNaN(part)) return;
        onRead(part);
        void api.saveProgress(path, { readPart: part, readTotal: script.parts.length }).catch(() => {});
      }, 2000);
    };
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [api, path, sync.playing, script.parts.length]);

  return (
    <article className="card lesson-body" ref={root}>
      {sync.playFrom && (
        <label className="row small muted follow-toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow the voice
        </label>
      )}
      <div className="md">
        {script.blocks.map((b, i) =>
          b.heading === 1 ? null : (
            <div
              key={i}
              {...(b.part !== null ? { "data-part": b.part } : {})}
              className={`lesson-block${b.part !== null && b.part === sync.speaking ? " is-speaking" : ""}${b.part !== null && sync.playFrom ? " can-play" : ""}${selected === b.part && b.part !== null ? " is-selected" : ""}`}
              onClick={(e) => {
                if (b.part === null || !sync.playFrom || (e.target as HTMLElement).closest("a, button")) return;
                setSelected(selected === b.part ? null : b.part);
              }}
            >
              <Markdown text={b.source} />
              {selected === b.part && b.part !== null && sync.playFrom && (
                <button
                  type="button"
                  className="small primary play-from"
                  onClick={() => {
                    sync.playFrom?.(b.part!);
                    setSelected(null);
                  }}
                >
                  <Icon name="play" size={14} /> Listen from here
                </button>
              )}
            </div>
          ),
        )}
      </div>
    </article>
  );
}

/** The recorded lesson, played by the app-wide player: chapters, seeking, speed, the listen-back check. */
function RecordingCard({
  api,
  audio,
  lesson,
  script,
  serverProgress,
  listened,
  stop,
  onSync,
  onEnded,
  onFindPlace,
  rerecord,
  rerecording,
  progress,
}: {
  api: Api;
  audio: LessonAudio;
  lesson: Lesson;
  script: Script;
  serverProgress: LessonProgress | null;
  listened: Listened;
  stop: { current: () => void };
  onSync: (s: Sync) => void;
  /** The recording played to the end (the player marks it listened): reload to show it. */
  onEnded: () => void;
  onFindPlace: (part: number) => void;
  rerecord: (() => Promise<void>) | null;
  rerecording: boolean;
  progress: { done: number; total: number } | null;
}) {
  const p = useLessonAudio();
  const marks = useMemo(() => (audio.marks?.length === script.parts.length ? audio.marks : estimateMarks(script.parts, audio.seconds)), [audio, script]);
  const mine = p.loaded?.path === lesson.path;
  const other = p.loaded && !mine ? p.loaded : null;
  const start = useMemo(() => startingPlace(localPlace(lesson.path), serverProgress), [lesson.path, serverProgress]);
  const loadThis = () => p.load({ path: lesson.path, title: lesson.title, audio, marks, done: lesson.status === "done" }, start);
  // Load it (paused) when nothing else is playing; never cut off another lesson by just opening this one.
  useEffect(() => {
    if (mine) p.load({ path: lesson.path, title: lesson.title, audio, marks, done: lesson.status === "done" });
    else if (!p.loaded) loadThis();
  }, [lesson.path, audio.url]);

  const time = mine ? p.time : start;
  const duration = mine ? p.duration : audio.seconds;
  const speaking = partAt(marks, time);
  const playFrom = (part: number) => {
    if (!mine) loadThis();
    p.seek(marks[part] ?? 0);
    p.play();
  };
  const serverAt = serverProgress?.audioAt ? Date.parse(serverProgress.audioAt) : 0;
  useEffect(() => {
    onSync({ speaking: mine ? speaking : null, playing: mine && p.playing, playFrom, listenedPart: time > 1 ? speaking : null, listenedAt: mine && p.playing ? Date.now() : Math.max(serverAt, localPlace(lesson.path)?.at ?? 0) });
  }, [speaking, mine, p.playing, Math.floor(time / 5)]);
  listened.current = p.minutesListened;
  stop.current = () => mine && p.pause();
  // Played to the end: the player has marked it listened; show that.
  useEffect(() => {
    if (mine && p.finished && lesson.status !== "done") {
      const t = setTimeout(onEnded, 1500);
      return () => clearTimeout(t);
    }
  }, [mine, p.finished]);

  // The full player scrolls away with the page; while it's out of view the mini player stands in.
  const card = useRef<HTMLDivElement | null>(null);
  const setVisible = p.setFullPlayerVisible;
  useEffect(() => {
    const el = card.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(Boolean(e?.isIntersecting)), { threshold: 0.15 });
    io.observe(el);
    return () => {
      io.disconnect();
      setVisible(false);
    };
  }, [setVisible]);
  const chapter = audio.chapters[chapterAt(audio.chapters, time)];
  const flagged = audio.flagged.length;
  const use = <T,>(fn: () => T) => () => {
    if (!mine) loadThis();
    return fn();
  };
  return (
    <>
      <div className="card lesson-player is-recording" aria-label="Listen to this lesson" ref={card}>
        {other && (
          <p className="small muted row between wrap" role="status">
            <span>Playing: {other.title}</span>
            <button className="small" onClick={() => { loadThis(); setTimeout(() => p.play(), 0); }}>
              Play this lesson instead
            </button>
          </p>
        )}
        <div className="row between small">
          <span className="muted clip">{chapter?.title ?? lesson.title}</span>
          <span className="muted nowrap">
            {clock(time)} / {clock(duration)}
          </span>
        </div>
        <input
          type="range"
          className="seek"
          min={0}
          max={Math.max(1, Math.floor(duration))}
          step={1}
          value={Math.floor(time)}
          onChange={(e) => {
            if (!mine) loadThis();
            p.seek(Number(e.target.value));
          }}
          aria-label="Position"
          aria-valuetext={`${clock(time)} of ${clock(duration)}`}
        />
        <div className="row player-buttons">
          <button aria-label="Previous chapter" title="Previous chapter" onClick={use(p.prevChapter)}>
            <Icon name="back" />
            <Icon name="back" />
          </button>
          <button aria-label="Back 15 seconds" title="Back 15 seconds" onClick={use(() => p.skip(-15))}>
            −15
          </button>
          <button
            className="primary play-big"
            aria-label={mine && p.playing ? "Pause" : "Play"}
            onClick={() => {
              if (!mine) {
                loadThis();
                setTimeout(() => p.play(), 0);
              } else p.toggle();
            }}
          >
            <Icon name={mine && p.playing ? "pause" : "play"} size={28} />
          </button>
          <button aria-label="Forward 30 seconds" title="Forward 30 seconds" onClick={use(() => p.skip(30))}>
            +30
          </button>
          <button aria-label="Next chapter" title="Next chapter" onClick={use(p.nextChapter)} disabled={chapterAt(audio.chapters, time) >= audio.chapters.length - 1}>
            <Icon name="chevron" />
            <Icon name="chevron" />
          </button>
        </div>
        <div className="row between wrap small">
          <label className="row">
            Speed
            <select value={p.speed} onChange={(e) => p.setSpeed(Number(e.target.value))} aria-label="Speed">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
          <button className="link small" onClick={() => onFindPlace(speaking)}>
            Find my place in the text
          </button>
          <details className="chapters">
            <summary>Chapters</summary>
            <ol>
              {audio.chapters.map((c, i) => (
                <li key={`${c.at}-${i}`}>
                  <button className={`link ${i === chapterAt(audio.chapters, time) ? "is-on" : ""}`} onClick={use(() => p.seek(c.at))}>
                    <span className="muted">{clock(c.at)}</span> {c.title}
                  </button>
                </li>
              ))}
            </ol>
          </details>
        </div>
        <p className="muted small">Keeps playing while you use the rest of the app.</p>
        {mine && p.error && <p className="error small">{p.error}</p>}
        {mine && p.finished && (
          <p className="row done-mark" role="status">
            <Icon name="check" size={14} /> That's the lesson: marked as listened.
          </p>
        )}
      </div>
      {/* Not inside the player: the player stays pinned at the top, so a long list there couldn't scroll. */}
      <article className="card lesson-check">
        <details className="check small">
          <summary className="muted">
            Checked by ear: {audio.checked ? (flagged ? `${flagged} of ${audio.checked} sentences may sound off` : `all ${audio.checked} sentences clear`) : "not checked"}
          </summary>
          {/* The actions first: below a long list they were out of reach (phones scrolled the list, not the page). */}
          <div className="row wrap between check-actions">
            <span className="muted">
              Fix a word in <a href={`#/brain/${encodeURIComponent("learning/pronunciation.md")}`}>the pronunciation list</a>, then re-record.
            </span>
            {rerecord &&
              (rerecording ? (
                <span className="muted" role="status">
                  Re-recording{progress?.total ? `: ${Math.round((progress.done / progress.total) * 100)}%` : "…"}
                </span>
              ) : (
                <button className="small" onClick={() => void rerecord()}>
                  Re-record
                </button>
              ))}
          </div>
          {flagged > 0 && (
            <ul>
              {audio.flagged.map((f, i) => (
                <li key={i}>
                  <strong>{f.missing.join(", ")}</strong> in “{f.text}” <span className="muted">(heard “{f.heard}”)</span>
                </li>
              ))}
            </ul>
          )}
        </details>
      </article>
    </>
  );
}

/** Before the recording exists: the live voice reads it, paragraph by paragraph (on this page only). */
function LiveCard({
  api,
  config,
  lesson,
  script,
  narrator,
  listened,
  stop,
  onSync,
  onFinished,
  status,
  record,
}: {
  api: Api;
  config: VoiceConfig | null;
  lesson: Lesson;
  script: Script;
  narrator: string;
  listened: Listened;
  stop: { current: () => void };
  onSync: (s: Sync) => void;
  onFinished: () => void;
  status: string | null;
  record: (() => Promise<void>) | null;
}) {
  const query = useRouteQuery();
  const player = useLessonPlayer(api, config, lesson.path, script.parts, lesson.title, narrator);
  listened.current = player.minutesListened;
  stop.current = player.stop;
  const part = script.parts[player.index];
  const section = part ? script.sections[part.section] : undefined;
  const sectionIndex = part?.section ?? 0;
  useEffect(() => {
    onSync({ speaking: player.playing ? player.index : null, playing: player.playing, playFrom: (p) => void player.play(p), listenedPart: player.index > 0 ? player.index : null, listenedAt: 0 });
  }, [player.index, player.playing]);
  // While the live voice reads, notifications stay quiet too (with a heartbeat, as for recordings).
  useEffect(() => {
    void api.setListening(player.playing).catch(() => {});
    if (!player.playing) return;
    const t = setInterval(() => void api.setListening(true).catch(() => {}), 30_000);
    return () => {
      clearInterval(t);
      void api.setListening(false).catch(() => {});
    };
  }, [player.playing]);
  return (
    <div className={`card lesson-player ${query.get("listen") === "1" ? "is-first" : ""}`} aria-label="Listen to this lesson">
      {status && (
        <p className="small muted row between wrap" role="status">
          <span>{status}</span>
          {record && (
            <button className="small" onClick={() => void record()}>
              Record now
            </button>
          )}
        </p>
      )}
      <div className="row between small">
        <span className="muted">{section ? section.title : "Ready"}</span>
        <span className="muted">
          {script.parts.length ? `${player.index + 1}/${script.parts.length}` : ""} · {minutesLeft(script.parts, player.index)} min left
        </span>
      </div>
      <progress max={Math.max(1, script.parts.length - 1)} value={player.index} aria-label="Progress" />
      <div className="row player-buttons">
        <button aria-label="Previous section" title="Previous section" onClick={() => player.jump(script.sections[Math.max(0, sectionIndex - (player.index > (section?.first ?? 0) ? 0 : 1))]?.first ?? 0)}>
          <Icon name="back" />
          <Icon name="back" />
        </button>
        <button aria-label="Back a paragraph" title="Back a paragraph" onClick={() => player.jump(player.index - 1)}>
          <Icon name="back" />
        </button>
        <button className="primary play-big" aria-label={player.playing ? "Pause" : "Play"} onClick={player.toggle} disabled={!script.parts.length}>
          <Icon name={player.playing ? "pause" : "play"} size={28} />
        </button>
        <button aria-label="Forward a paragraph" title="Forward a paragraph" onClick={() => player.jump(player.index + 1)}>
          <Icon name="chevron" />
        </button>
        <button aria-label="Next section" title="Next section" onClick={() => player.jump(script.sections[sectionIndex + 1]?.first ?? script.parts.length - 1)}>
          <Icon name="chevron" />
          <Icon name="chevron" />
        </button>
      </div>
      {player.error && <p className="error small">{player.error}</p>}
      {player.finished && lesson.status !== "done" && (
        <p className="row">
          <span>That's the lesson.</span>
          <button className="primary" onClick={onFinished}>
            Mark as listened
          </button>
        </p>
      )}
    </div>
  );
}
