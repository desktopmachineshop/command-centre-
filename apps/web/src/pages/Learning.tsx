import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Api, LearningStats, LearningSuggestion, LearningTrack, LearningView, Lesson, VoiceConfig } from "../api";
import { Icon } from "../icons";
import { useLessonPlayer } from "../learning/player";
import { lessonScript, minutesLeft } from "../learning/script";
import { type LiveFeed, useLoad } from "../live";
import { Markdown } from "../markdown";
import { go, useRouteQuery } from "../router";
import { freeVoiceDefault, readLearningVoice, writeLearningVoice } from "../voice/choice";
import { VoicePicker } from "../voice/VoicePicker";

const lessonHref = (path: string, listen = false) => `learning/${encodeURIComponent(path)}${listen ? "?listen=1" : ""}`;
const dayLabel = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T12:00:00Z`));
const hours = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`);

/** Picks the free voice for lessons the first time Learning opens (the server's own, else the device's). */
function useFreeVoiceDefault(api: Api) {
  useEffect(() => {
    if (readLearningVoice() !== null) return;
    api
      .voices()
      .then((list) => writeLearningVoice(freeVoiceDefault(list.voices)))
      .catch(() => writeLearningVoice("device"));
  }, [api]);
}

/** Learning: today's lesson, picking another or asking for one, the scoreboard, and every lesson. */
export function Learning({ api, feed, path }: { api: Api; feed: LiveFeed; path?: string }) {
  useFreeVoiceDefault(api);
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
        </>
      )}
      {!view.data && !view.error && <p className="muted">Loading…</p>}
    </section>
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
      <p className="row small">
        <TrackChip track={l.track} tracks={view.tracks} />
        <span className="muted">
          {l.listenMinutes} min listen · {l.readMinutes} min read
        </span>
      </p>
      {l.summary && <p>{l.summary}</p>}
      <div className="row learning-actions">
        <button className="primary big" onClick={() => go(lessonHref(l.path, true))}>
          <Icon name="play" /> Listen
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
  const [status, setStatus] = useState<"" | "ready" | "done">("");
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
      {shown.length === 0 && <p className="muted small">{view.lessons.length ? "None match." : "No lessons yet. The first arrives tomorrow morning, or ask for one above."}</p>}
      <ul className="list">
        {shown.map((l) => (
          <li key={l.path} className="item" onClick={() => go(lessonHref(l.path))}>
            <div className="row between small">
              <span className="row">
                <TrackChip track={l.track} tracks={view.tracks} />
                <span className="muted">{dayLabel(l.created)}</span>
              </span>
              {l.status === "done" ? (
                <span className="done-mark">
                  <Icon name="check" size={14} /> {l.completedMode === "listen" ? "Listened" : "Read"}
                </span>
              ) : (
                <span className="muted">{l.listenMinutes} min</span>
              )}
            </div>
            <p className="title">{l.title}</p>
            {l.summary && <p className="small clip">{l.summary}</p>}
          </li>
        ))}
      </ul>
    </article>
  );
}

// ---------- one lesson ----------

function LessonPage({ api, path, onChange, tracks }: { api: Api; path: string; onChange: () => void; tracks: LearningTrack[] }) {
  const [data, setData] = useState<{ lesson: Lesson; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const load = () =>
    api
      .lesson(path)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setData(null);
    void load();
    api.voiceConfig().then(setConfig).catch(() => setConfig(null));
  }, [path]);
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return <LessonView api={api} config={config} lesson={data.lesson} body={data.body} tracks={tracks} onChange={() => void load().then(onChange)} />;
}

function LessonView({ api, config, lesson, body, tracks, onChange }: { api: Api; config: VoiceConfig | null; lesson: Lesson; body: string; tracks: LearningTrack[]; onChange: () => void }) {
  const query = useRouteQuery();
  const script = useMemo(() => lessonScript(body, lesson.title), [body, lesson.title]);
  const player = useLessonPlayer(api, config, lesson.path, script.parts, lesson.title);
  const opened = useRef(Date.now());
  const [rating, setRating] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showVoice, setShowVoice] = useState(false);
  const part = script.parts[player.index];
  const section = part ? script.sections[part.section] : undefined;
  const sectionIndex = part?.section ?? 0;
  const listenFirst = query.get("listen") === "1";

  const complete = async (mode: "read" | "listen") => {
    setErr(null);
    const spent = mode === "listen" ? player.minutesListened() : Math.round((Date.now() - opened.current) / 60_000);
    try {
      player.stop();
      // Under five minutes is a skim or a resumed session: credit the lesson's own length.
      await api.completeLesson(lesson.path, mode, { ...(spent >= 5 ? { minutes: Math.min(spent, 240) } : {}), ...(rating ? { rating } : {}) });
      onChange();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

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
        </p>
      </header>

      <div className={`card lesson-player ${listenFirst ? "is-first" : ""}`} aria-label="Listen to this lesson">
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
        {player.playing && part && <p className="now-reading">{part.text}</p>}
        {player.error && <p className="error small">{player.error}</p>}
        {player.finished && lesson.status !== "done" && (
          <p className="row">
            <span>That's the lesson.</span>
            <button className="primary" onClick={() => void complete("listen")}>
              Mark as listened
            </button>
          </p>
        )}
        <button className="link small" onClick={() => setShowVoice((v) => !v)}>
          {showVoice ? "Hide voice" : "Voice"}
        </button>
        {showVoice && <VoicePicker api={api} config={config} learning sample={`Today's lesson: ${lesson.title}.`} />}
      </div>

      <article className="card lesson-body">
        <Markdown text={body.replace(/^#\s+.*\n+/, "")} />
      </article>

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
