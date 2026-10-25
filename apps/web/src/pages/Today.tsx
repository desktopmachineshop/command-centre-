import { type FormEvent, useState } from "react";
import type { Api, CalendarEvent, Reminder, TodayView, TodoItem, TodoList } from "../api";
import { type LiveFeed, useLoad } from "../live";
import { go } from "../router";

const TZ = "Europe/London";
const time = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const dayTitle = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" }).format(new Date(`${day}T12:00:00Z`));
const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Today: the agenda, reminders due and to-do lists, with a quick-add box that asks the assistant. */
export function Today({ api, feed }: { api: Api; feed: LiveFeed }) {
  const [day, setDay] = useState<string | undefined>(undefined);
  // Agent runs add reminders and items, so reload when a task finishes.
  const { data, error, reload } = useLoad(() => api.today(day), feed, (m) => m.type === "task.updated" && m.task.status !== "running", [day]);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="today-page">
      <div className="row between">
        <h2>{data ? dayTitle(data.day) : "Today"}</h2>
        <span className="row">
          {data && (
            <>
              <button aria-label="Previous day" onClick={() => setDay(shiftDay(data.day, -1))}>‹</button>
              {day && <button onClick={() => setDay(undefined)}>Today</button>}
              <button aria-label="Next day" onClick={() => setDay(shiftDay(data.day, 1))}>›</button>
            </>
          )}
        </span>
      </div>
      <QuickAdd api={api} />
      {(error || err) && <p className="error">{error ?? err}</p>}
      {data && (
        <>
          <Agenda view={data} />
          <Reminders reminders={data.reminders} upcoming={data.upcoming} run={run} api={api} />
          <Lists lists={data.lists} run={run} api={api} />
        </>
      )}
    </section>
  );
}

/** Natural language goes to the assistant in Chat ("remind me…", "add milk to shopping"). */
function QuickAdd({ api }: { api: Api }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    setError(null);
    try {
      const { task } = await api.chat(message, "personal");
      setSent({ id: task.id, text: message });
      setText("");
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="card quick-add" onSubmit={submit}>
      <label className="grow">
        <span className="muted small">Ask the assistant</span>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Remind me to call the garage at 4pm · add milk to shopping" enterKeyHint="send" />
      </label>
      <button className="primary" type="submit" disabled={!text.trim()}>
        Send
      </button>
      {sent && (
        <p className="muted small">
          Sent “{sent.text}”. <a onClick={() => go(`task/${sent.id}`)}>Follow it</a>
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Agenda({ view }: { view: TodayView }) {
  return (
    <section className="card" aria-labelledby="agenda-h">
      <h3 id="agenda-h">Agenda</h3>
      {!view.calendarConfigured && <p className="muted small">
          No calendar connected. <a href="#/accounts">Connect a Google account</a> in Accounts.
        </p>}
      {view.calendarErrors.map((e) => (
        <p key={e} className="error small">
          {e}
        </p>
      ))}
      {view.calendarConfigured && view.events.length === 0 && <p className="muted">Nothing in the calendar.</p>}
      <ul className="list">
        {view.events.map((e) => (
          <EventRow key={`${e.calendarId}/${e.id}`} event={e} many={new Set(view.events.map((x) => x.calendarId)).size > 1} />
        ))}
      </ul>
    </section>
  );
}

function EventRow({ event: e, many }: { event: CalendarEvent; many: boolean }) {
  return (
    <li className={`item row ${e.response === "declined" ? "muted" : ""}`}>
      <time className="muted small" dateTime={e.start}>
        {e.allDay ? "All day" : `${time(e.start)}–${time(e.end)}`}
      </time>
      <span className="grow">
        {e.url ? (
          <a href={e.url} target="_blank" rel="noreferrer">
            {e.title}
          </a>
        ) : (
          e.title
        )}
        {e.location && <span className="muted small"> · {e.location}</span>}
        {e.response === "declined" && <span className="muted small"> · declined</span>}
      </span>
      {many && <span className="tag">{e.calendarName}</span>}
    </li>
  );
}

function Reminders({ reminders, upcoming, run, api }: { reminders: Reminder[]; upcoming: Reminder[]; run: (fn: () => Promise<unknown>) => void; api: Api }) {
  return (
    <section className="card" aria-labelledby="reminders-h">
      <h3 id="reminders-h">Reminders</h3>
      {reminders.length === 0 && <p className="muted">None due.</p>}
      <ul className="list">
        {reminders.map((r) => (
          <li key={r.id} className="item row wrap">
            <span className="grow">
              {r.text}
              <span className="muted small">
                {" "}
                · {when(r.snoozedUntil ?? r.dueAt)}
                {r.recurrence ? " · repeats" : ""}
                {r.status === "sent" ? " · sent" : ""}
              </span>
            </span>
            <span className="row">
              <button onClick={() => run(() => api.snoozeReminder(r.id, 60))}>Snooze 1h</button>
              <button className="primary" onClick={() => run(() => api.completeReminder(r.id))}>
                Done
              </button>
            </span>
          </li>
        ))}
      </ul>
      {upcoming.length > 0 && (
        <details>
          <summary className="muted small">Coming up ({upcoming.length})</summary>
          <ul className="list small">
            {upcoming.map((r) => (
              <li key={r.id} className="row between">
                <span>{r.text}</span>
                <span className="muted">{when(r.dueAt)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Lists({ lists, run, api }: { lists: (TodoList & { items: TodoItem[] })[]; run: (fn: () => Promise<unknown>) => void; api: Api }) {
  const [name, setName] = useState("");
  return (
    <section aria-labelledby="lists-h">
      <h3 id="lists-h">Lists</h3>
      {lists.map((l) => (
        <ListCard key={l.id} list={l} run={run} api={api} />
      ))}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) run(() => api.createList(name.trim()).then(() => setName("")));
        }}
      >
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="New list" aria-label="New list name" />
        <button type="submit" disabled={!name.trim()}>
          Add list
        </button>
      </form>
    </section>
  );
}

function ListCard({ list, run, api }: { list: TodoList & { items: TodoItem[] }; run: (fn: () => Promise<unknown>) => void; api: Api }) {
  const [text, setText] = useState("");
  const [showDone, setShowDone] = useState(false);
  const open = list.items.filter((i) => !i.done);
  const done = list.items.filter((i) => i.done);
  const rename = () => {
    const next = prompt("Rename list", list.name);
    if (next?.trim() && next.trim() !== list.name) run(() => api.renameList(list.id, next.trim()));
  };
  const remove = () => {
    if (confirm(`Delete the ${list.name} list and its ${list.items.length} items?`)) run(() => api.deleteList(list.id));
  };
  return (
    <div className="card todo-list">
      <div className="row between">
        <strong>
          {list.name}
          {list.vertical !== "personal" && <span className="tag"> {list.vertical}</span>}
        </strong>
        <span className="row small">
          <a onClick={rename}>Rename</a>
          <a onClick={remove}>Delete</a>
        </span>
      </div>
      <ul className="list">
        {[...open, ...(showDone ? done : [])].map((i) => (
          <li key={i.id} className="row">
            <label className="row grow">
              <input type="checkbox" checked={i.done} onChange={() => run(() => api.setItemDone(i.id, !i.done))} />
              <span className={i.done ? "muted" : ""}>
                {i.done ? <s>{i.text}</s> : i.text}
                {i.dueDate && <span className="muted small"> · due {i.dueDate.split("-").reverse().join("/")}</span>}
              </span>
            </label>
            <button className="small" aria-label={`Remove ${i.text}`} onClick={() => run(() => api.deleteItem(i.id))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      {open.length === 0 && <p className="muted small">All done.</p>}
      {done.length > 0 && (
        <a className="small" onClick={() => setShowDone(!showDone)}>
          {showDone ? "Hide done" : `Show done (${done.length})`}
        </a>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) run(() => api.addItem(list.id, text.trim()).then(() => setText("")));
        }}
      >
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${list.name}`} aria-label={`Add to ${list.name}`} />
        <button type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
    </div>
  );
}
