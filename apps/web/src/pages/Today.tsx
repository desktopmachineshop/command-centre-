import { type FormEvent, useState } from "react";
import type { Api, CalendarEvent, Reminder, TodayView, TodoItem, TodoList } from "../api";
import { type LiveFeed, useLoad } from "../live";
import { go } from "../router";
import { Dialog } from "../ui";

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
  /** The reminder being edited, or "new". */
  const [editing, setEditing] = useState<Reminder | "new" | null>(null);
  return (
    <section className="card" aria-labelledby="reminders-h">
      <div className="row between">
        <h3 id="reminders-h">Reminders</h3>
        <button className="ghost" onClick={() => setEditing("new")}>
          Add
        </button>
      </div>
      {reminders.length === 0 && <p className="muted">None due.</p>}
      <ul className="list">
        {reminders.map((r) => (
          <li key={r.id} className="item row wrap">
            <span className="grow">
              {r.text}
              <span className="muted small">
                {" "}
                · {when(r.snoozedUntil ?? r.dueAt)}
                {r.recurrence ? ` · ${repeatLabel(r.recurrence)}` : ""}
                {r.status === "sent" ? " · sent" : ""}
              </span>
            </span>
            <span className="row">
              <button className="ghost" onClick={() => setEditing(r)}>
                Edit
              </button>
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
                <span>
                  {r.text}
                  {r.recurrence ? <span className="muted"> · {repeatLabel(r.recurrence)}</span> : null}
                </span>
                <span className="row">
                  <span className="muted">{when(r.dueAt)}</span>
                  <button className="link" onClick={() => setEditing(r)} aria-label={`Edit ${r.text}`}>
                    Edit
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {editing && <ReminderDialog api={api} reminder={editing === "new" ? null : editing} close={() => setEditing(null)} saved={() => run(async () => setEditing(null))} />}
    </section>
  );
}

// --- Reminder editor ---

const DAYS = [
  ["mon", "Mon"],
  ["tue", "Tue"],
  ["wed", "Wed"],
  ["thu", "Thu"],
  ["fri", "Fri"],
  ["sat", "Sat"],
  ["sun", "Sun"],
] as const;
const RRULE_DAYS: Record<string, string> = { MO: "mon", TU: "tue", WE: "wed", TH: "thu", FR: "fri", SA: "sat", SU: "sun" };

type Repeat = { kind: "none" | "daily" | "weekdays" | "weekly" | "monthly"; days: string[] };

/** The stored RRULE as the editor's choice. */
function repeatOf(rrule: string | null): Repeat {
  const r = rrule ?? "";
  if (/^FREQ=DAILY$/.test(r)) return { kind: "daily", days: [] };
  const weekly = /^FREQ=WEEKLY;BYDAY=([A-Z,]+)$/.exec(r);
  if (weekly) {
    const days = weekly[1]!.split(",").map((d) => RRULE_DAYS[d]!).filter(Boolean);
    return days.join() === "mon,tue,wed,thu,fri" ? { kind: "weekdays", days } : { kind: "weekly", days };
  }
  if (/^FREQ=MONTHLY;BYMONTHDAY=\d+$/.test(r)) return { kind: "monthly", days: [] };
  return { kind: "none", days: [] };
}

/** "weekdays", "every Mon, Thu", "monthly on the 15th", "every day". */
function repeatLabel(rrule: string): string {
  const r = repeatOf(rrule);
  if (r.kind === "daily") return "every day";
  if (r.kind === "weekdays") return "weekdays";
  if (r.kind === "weekly") return `every ${r.days.map((d) => DAYS.find(([k]) => k === d)![1]).join(", ")}`;
  const n = /BYMONTHDAY=(\d+)/.exec(rrule)?.[1];
  return r.kind === "monthly" ? `monthly on day ${n}` : "repeats";
}

/** An instant as the London wall-clock value a datetime-local input takes: YYYY-MM-DDTHH:MM. */
function localInput(iso: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Edit (or add) a reminder: what, when (London time) and how it repeats. */
function ReminderDialog({ api, reminder, close, saved }: { api: Api; reminder: Reminder | null; close: () => void; saved: () => void }) {
  const [text, setText] = useState(reminder?.text ?? "");
  const [due, setDue] = useState(() => localInput(reminder?.dueAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  const [repeat, setRepeat] = useState<Repeat>(() => repeatOf(reminder?.recurrence ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recurrence = (r: Repeat = repeat, day: string = due): string => {
    switch (r.kind) {
      case "none":
        return "none";
      case "weekly":
        return `weekly:${r.days.join(",")}`;
      case "monthly":
        return `monthly:${Number(day.slice(8, 10))}`;
      default:
        return r.kind;
    }
  };
  // What the form opened with, so a save sends only the changes.
  const [initial] = useState(() => ({ due, recurrence: recurrence() }));

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      saved();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (repeat.kind === "weekly" && !repeat.days.length) return setError("Pick at least one day.");
    const rec = recurrence();
    if (!reminder) return void act(() => api.addReminder({ text: text.trim(), due, recurrence: rec === "none" ? null : rec }));
    // Send only what changed: a text-only edit keeps the schedule (and any snooze) as it is.
    const change: { text?: string; due?: string; recurrence?: string } = {};
    if (text.trim() !== reminder.text) change.text = text.trim();
    if (due !== initial.due) change.due = due;
    if (rec !== initial.recurrence) change.recurrence = rec;
    if (!Object.keys(change).length) return close();
    void act(() => api.updateReminder(reminder.id, change));
  };

  const toggleDay = (d: string) =>
    setRepeat((r) => ({ ...r, days: r.days.includes(d) ? r.days.filter((x) => x !== d) : DAYS.map(([k]) => k).filter((k) => k === d || r.days.includes(k)) }));

  return (
    <Dialog
      title={reminder ? "Edit reminder" : "New reminder"}
      onClose={close}
      footer={
        <div className="row between">
          {reminder ? (
            <button type="button" className="ghost danger" disabled={busy} onClick={() => confirm(`Delete "${reminder.text}"${reminder.recurrence ? " and all its repeats" : ""}?`) && void act(() => api.cancelReminder(reminder.id))}>
              Delete
            </button>
          ) : (
            <span />
          )}
          <span className="row">
            <button type="button" className="ghost" onClick={close}>
              Cancel
            </button>
            <button type="submit" form="reminder-form" className="primary" disabled={busy || !text.trim() || !due}>
              {busy ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      }
    >
      <form id="reminder-form" onSubmit={save}>
        <label className="field">
          <span>Reminder</span>
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={500} required placeholder="Put the bins out" />
        </label>
        <label className="field">
          <span>{repeat.kind === "none" ? "When" : "Starts (and time of day)"}</span>
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} required />
          <span className="muted small">UK time</span>
        </label>
        <label className="field">
          <span>Repeats</span>
          <select value={repeat.kind} onChange={(e) => setRepeat({ kind: e.target.value as Repeat["kind"], days: repeat.days.length ? repeat.days : [DAYS[(new Date(`${due.slice(0, 10)}T12:00:00Z`).getUTCDay() + 6) % 7]![0]] })}>
            <option value="none">Doesn't repeat</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekly">Weekly on…</option>
            <option value="monthly">Monthly on day {Number(due.slice(8, 10)) || "…"}</option>
          </select>
        </label>
        {repeat.kind === "weekly" && (
          <div className="chips" role="group" aria-label="Days">
            {DAYS.map(([key, label]) => (
              <label key={key} className={`chip ${repeat.days.includes(key) ? "on" : ""}`}>
                <input type="checkbox" checked={repeat.days.includes(key)} onChange={() => toggleDay(key)} />
                {label}
              </label>
            ))}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </form>
    </Dialog>
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
