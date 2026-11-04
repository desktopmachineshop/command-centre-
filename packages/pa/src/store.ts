import { randomUUID } from "node:crypto";
import { formatRecurrence, parseRecurrence, type Recurrence } from "./recurrence";

/** What PgPaStore needs from a pg Pool (or client): parameterised queries. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type CreatedBy = "dave" | "agent";
export type ReminderStatus = "pending" | "sent" | "done" | "cancelled";

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  recurrence: string | null;
  localTime: string;
  timeZone: string;
  vertical: string;
  createdBy: CreatedBy;
  taskId: string | null;
  status: ReminderStatus;
  snoozedUntil: string | null;
  lastSentAt: string | null;
  sentCount: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every change; deliveries compare it so only one replica sends. */
  version: number;
  /** A number to call when it fires (the Call button), or null. */
  phone: string | null;
}

export interface TodoList {
  id: string;
  vertical: string;
  name: string;
  position: number;
  openCount: number;
  doneCount: number;
  createdAt: string;
}

export interface TodoItem {
  id: string;
  listId: string;
  listName: string;
  vertical: string;
  text: string;
  done: boolean;
  doneAt: string | null;
  position: number;
  dueDate: string | null;
  createdBy: CreatedBy;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, any>;
const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
const date = (v: Date | string | null): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  // pg returns `date` columns as local-midnight Dates; read them back in local time.
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
};

const toReminder = (r: Row): Reminder => ({
  id: r.id,
  text: r.text,
  dueAt: iso(r.due_at)!,
  recurrence: r.recurrence,
  localTime: r.local_time,
  timeZone: r.timezone,
  vertical: r.vertical,
  createdBy: r.created_by,
  taskId: r.task_id,
  status: r.status,
  snoozedUntil: iso(r.snoozed_until),
  lastSentAt: iso(r.last_sent_at),
  sentCount: r.sent_count,
  completedAt: iso(r.completed_at),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  version: r.version,
  phone: r.phone ?? null,
});

const toList = (r: Row): TodoList => ({
  id: r.id,
  vertical: r.vertical,
  name: r.name,
  position: r.position,
  openCount: Number(r.open_count ?? 0),
  doneCount: Number(r.done_count ?? 0),
  createdAt: iso(r.created_at)!,
});

const toItem = (r: Row): TodoItem => ({
  id: r.id,
  listId: r.list_id,
  listName: r.list_name,
  vertical: r.vertical,
  text: r.text,
  done: r.done,
  doneAt: iso(r.done_at),
  position: r.position,
  dueDate: date(r.due_date),
  createdBy: r.created_by,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const ITEM_SELECT = `select i.*, l.name as list_name, l.vertical from todo_items i join todo_lists l on l.id = i.list_id`;
const LIST_SELECT = `
  select l.*,
    (select count(*) from todo_items i where i.list_id = l.id and not i.done) as open_count,
    (select count(*) from todo_items i where i.list_id = l.id and i.done) as done_count
  from todo_lists l`;

export class PaNotFound extends Error {}

/** The open (not finished) reminder states. */
export const OPEN_REMINDER: ReminderStatus[] = ["pending", "sent"];

/**
 * All PA SQL: reminders, lists and items. Every method that takes `vertical`
 * only touches rows of that vertical; undefined means Dave (every vertical).
 */
export class PgPaStore {
  constructor(private readonly db: Queryable) {}

  // --- Reminders ---

  async addReminder(r: {
    text: string;
    dueAt: Date;
    recurrence: Recurrence | null;
    localTime: string;
    timeZone: string;
    vertical: string;
    createdBy: CreatedBy;
    taskId?: string | null;
    phone?: string | null;
  }): Promise<Reminder> {
    const { rows } = await this.db.query(
      `insert into reminders (id, text, due_at, recurrence, local_time, timezone, vertical, created_by, task_id, status, phone)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10) returning *`,
      [randomUUID(), r.text, r.dueAt, r.recurrence ? formatRecurrence(r.recurrence) : null, r.localTime, r.timeZone, r.vertical, r.createdBy, r.taskId ?? null, r.phone ?? null],
    );
    return toReminder(rows[0]);
  }

  async getReminder(id: string, vertical?: string): Promise<Reminder | null> {
    const { rows } = await this.db.query(`select * from reminders where id = $1 and ($2::text is null or vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return rows[0] ? toReminder(rows[0]) : null;
  }

  /** Reminders by status (default: open), soonest first. */
  async listReminders(options: { vertical?: string; statuses?: ReminderStatus[]; dueBefore?: Date; limit?: number } = {}): Promise<Reminder[]> {
    const { rows } = await this.db.query(
      `select * from reminders
       where status = any($1) and ($2::text is null or vertical = $2)
         and ($3::timestamptz is null or least(due_at, coalesce(snoozed_until, due_at)) < $3)
       order by least(due_at, coalesce(snoozed_until, due_at)), created_at limit $4`,
      [options.statuses ?? OPEN_REMINDER, options.vertical ?? null, options.dueBefore ?? null, options.limit ?? 100],
    );
    return rows.map(toReminder);
  }

  async completeReminder(id: string, vertical?: string): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update reminders set status = 'done', completed_at = now(), snoozed_until = null, updated_at = now(), version = version + 1
       where id = $1 and status = any($2) and ($3::text is null or vertical = $3) returning *`,
      [uuidOrNil(id), OPEN_REMINDER, vertical ?? null],
    );
    return rows[0] ? toReminder(rows[0]) : null;
  }

  /**
   * "Done" on the alert for the occurrence due at `dueAt` (null if it has moved on).
   * A one-off completes; a recurring one only acknowledges this occurrence (clears
   * any snooze) and its series stays pending.
   */
  async acknowledgeReminder(id: string, dueAt: Date): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update reminders set
         status = case when recurrence is null then 'done' else status end,
         completed_at = case when recurrence is null then now() else completed_at end,
         snoozed_until = null, updated_at = now(), version = version + 1
       where id = $1 and status = any($2) and due_at = $3 returning *`,
      [uuidOrNil(id), OPEN_REMINDER, dueAt],
    );
    return rows[0] ? toReminder(rows[0]) : null;
  }

  /**
   * Changes an open reminder's text and/or timing. With `schedule` the reminder
   * moves there and is pending again (any snooze cleared); without it only the text changes.
   * `phone`: undefined keeps the number, null removes it.
   */
  async updateReminder(
    id: string,
    patch: { text: string; phone?: string | null; schedule?: { dueAt: Date; recurrence: Recurrence | null; localTime: string } },
    vertical?: string,
  ): Promise<Reminder | null> {
    const s = patch.schedule;
    const { rows } = await this.db.query(
      `update reminders set
         text = $2,
         due_at = coalesce($3, due_at),
         recurrence = case when $6 then $4 else recurrence end,
         local_time = coalesce($5, local_time),
         status = case when $6 then 'pending' else status end,
         snoozed_until = case when $6 then null else snoozed_until end,
         phone = case when $9 then $10 else phone end,
         updated_at = now(), version = version + 1
       where id = $1 and status = any($7) and ($8::text is null or vertical = $8) returning *`,
      [
        uuidOrNil(id),
        patch.text,
        s?.dueAt ?? null,
        s?.recurrence ? formatRecurrence(s.recurrence) : null,
        s?.localTime ?? null,
        !!s,
        OPEN_REMINDER,
        vertical ?? null,
        patch.phone !== undefined,
        patch.phone ?? null,
      ],
    );
    return rows[0] ? toReminder(rows[0]) : null;
  }

  async cancelReminder(id: string, vertical?: string): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update reminders set status = 'cancelled', snoozed_until = null, updated_at = now(), version = version + 1
       where id = $1 and status = any($2) and ($3::text is null or vertical = $3) returning *`,
      [uuidOrNil(id), OPEN_REMINDER, vertical ?? null],
    );
    return rows[0] ? toReminder(rows[0]) : null;
  }

  /**
   * Snooze until `until`. A one-off reminder simply moves (and is pending again);
   * a recurring one gets a one-off re-alert and its series stays on schedule.
   */
  async snoozeReminder(id: string, until: Date, vertical?: string, dueAt?: Date): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update reminders set
         due_at = case when recurrence is null then $2 else due_at end,
         snoozed_until = case when recurrence is null then null else $2 end,
         status = case when recurrence is null then 'pending' else status end,
         updated_at = now(), version = version + 1
       where id = $1 and status = any($3) and ($4::text is null or vertical = $4) and ($5::timestamptz is null or due_at = $5) returning *`,
      [uuidOrNil(id), until, OPEN_REMINDER, vertical ?? null, dueAt ?? null],
    );
    return rows[0] ? toReminder(rows[0]) : null;
  }

  /** Reminders whose time (or snooze) has come. */
  async dueReminders(now: Date, limit = 50): Promise<Reminder[]> {
    const { rows } = await this.db.query(
      `select * from reminders
       where (status = 'pending' and due_at <= $1) or (status = any($2) and snoozed_until <= $1)
       order by least(due_at, coalesce(snoozed_until, due_at)) limit $3`,
      [now, OPEN_REMINDER, limit],
    );
    return rows.map(toReminder);
  }

  /**
   * Records a delivery, only if the row is unchanged since it was read
   * (`version`), so two replicas can't both send it. False: someone else won.
   */
  async markReminderSent(r: Reminder, next: { status: ReminderStatus; dueAt: Date; snoozedUntil: Date | null }, now: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update reminders set status = $3, due_at = $4, snoozed_until = $5, last_sent_at = $6, sent_count = sent_count + 1, updated_at = now(), version = version + 1
       where id = $1 and version = $2`,
      [r.id, r.version, next.status, next.dueAt, next.snoozedUntil, now],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- Lists ---

  async listLists(vertical?: string): Promise<TodoList[]> {
    const { rows } = await this.db.query(`${LIST_SELECT} where ($1::text is null or l.vertical = $1) order by l.vertical, l.position, l.created_at`, [
      vertical ?? null,
    ]);
    return rows.map(toList);
  }

  async getList(id: string, vertical?: string): Promise<TodoList | null> {
    const { rows } = await this.db.query(`${LIST_SELECT} where l.id = $1 and ($2::text is null or l.vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return rows[0] ? toList(rows[0]) : null;
  }

  async findList(vertical: string, name: string): Promise<TodoList | null> {
    const { rows } = await this.db.query(`${LIST_SELECT} where l.vertical = $1 and lower(l.name) = lower($2)`, [vertical, name.trim()]);
    return rows[0] ? toList(rows[0]) : null;
  }

  /** The list called `name` (case-insensitive) in the vertical, created if missing. */
  async ensureList(vertical: string, name: string): Promise<TodoList> {
    const clean = name.trim();
    if (!clean) throw new Error("list name must not be empty");
    await this.db.query(
      `insert into todo_lists (id, vertical, name, position)
       values ($1, $2, $3, (select coalesce(max(position), -1) + 1 from todo_lists where vertical = $2))
       on conflict (vertical, lower(name)) do nothing`,
      [randomUUID(), vertical, clean],
    );
    return (await this.findList(vertical, clean))!;
  }

  async renameList(id: string, name: string, vertical?: string): Promise<TodoList | null> {
    const { rows } = await this.db.query(`update todo_lists set name = $2 where id = $1 and ($3::text is null or vertical = $3) returning id`, [
      uuidOrNil(id),
      name.trim(),
      vertical ?? null,
    ]);
    return rows[0] ? this.getList(id) : null;
  }

  async deleteList(id: string, vertical?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(`delete from todo_lists where id = $1 and ($2::text is null or vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return (rowCount ?? 0) > 0;
  }

  /** Puts lists in the given order (ids not given keep their place after them). */
  async reorderLists(ids: string[], vertical?: string): Promise<void> {
    await this.db.query(
      `update todo_lists l set position = o.ord from unnest($1::uuid[]) with ordinality as o(id, ord)
       where l.id = o.id and ($2::text is null or l.vertical = $2)`,
      [ids.map(uuidOrNil), vertical ?? null],
    );
  }

  // --- Items ---

  async addItems(listId: string, items: { text: string; dueDate?: string | null }[], createdBy: CreatedBy): Promise<TodoItem[]> {
    if (!items.length) return [];
    const ids = items.map(() => randomUUID());
    await this.db.query(
      `insert into todo_items (id, list_id, text, position, due_date, created_by)
       select x.id, $2, x.text, (select coalesce(max(position), -1) from todo_items where list_id = $2) + x.ord, x.due::date, $3
       from unnest($1::uuid[], $4::text[], $5::text[]) with ordinality as x(id, text, due, ord)`,
      [ids, listId, createdBy, items.map((i) => i.text.trim()), items.map((i) => i.dueDate ?? null)],
    );
    const { rows } = await this.db.query(`${ITEM_SELECT} where i.id = any($1) order by i.position`, [ids]);
    return rows.map(toItem);
  }

  async getItem(id: string, vertical?: string): Promise<TodoItem | null> {
    const { rows } = await this.db.query(`${ITEM_SELECT} where i.id = $1 and ($2::text is null or l.vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  /** A list's items: open ones in order, then (if asked) recently done ones. */
  async listItems(listId: string, options: { includeDone?: boolean; limit?: number } = {}): Promise<TodoItem[]> {
    const { rows } = await this.db.query(
      `${ITEM_SELECT} where i.list_id = $1 and ($2 or not i.done)
       order by i.done, case when i.done then null else i.position end, i.done_at desc nulls last limit $3`,
      [listId, options.includeDone ?? false, options.limit ?? 200],
    );
    return rows.map(toItem);
  }

  /**
   * The top open items across lists: overdue or due today first (by due date),
   * then the "today" list, then other lists in order.
   */
  async topItems(options: { vertical?: string; today: string; limit?: number }): Promise<TodoItem[]> {
    const { rows } = await this.db.query(
      `${ITEM_SELECT} where not i.done and ($1::text is null or l.vertical = $1)
       order by (i.due_date is not null and i.due_date <= $2::date) desc, i.due_date nulls last,
                (lower(l.name) = 'today') desc, l.position, i.position
       limit $3`,
      [options.vertical ?? null, options.today, options.limit ?? 10],
    );
    return rows.map(toItem);
  }

  async setItemDone(id: string, done: boolean, vertical?: string): Promise<TodoItem | null> {
    const { rows } = await this.db.query(
      `update todo_items i set done = $2, done_at = case when $2 then now() else null end, updated_at = now()
       from todo_lists l where i.id = $1 and l.id = i.list_id and ($3::text is null or l.vertical = $3) returning i.id`,
      [uuidOrNil(id), done, vertical ?? null],
    );
    return rows[0] ? this.getItem(id) : null;
  }

  async updateItem(id: string, patch: { text?: string; dueDate?: string | null }, vertical?: string): Promise<TodoItem | null> {
    const { rows } = await this.db.query(
      `update todo_items i set text = coalesce($2, i.text), due_date = case when $3 then $4::date else i.due_date end, updated_at = now()
       from todo_lists l where i.id = $1 and l.id = i.list_id and ($5::text is null or l.vertical = $5) returning i.id`,
      [uuidOrNil(id), patch.text?.trim() ?? null, patch.dueDate !== undefined, patch.dueDate ?? null, vertical ?? null],
    );
    return rows[0] ? this.getItem(id) : null;
  }

  async deleteItem(id: string, vertical?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `delete from todo_items i using todo_lists l where i.id = $1 and l.id = i.list_id and ($2::text is null or l.vertical = $2)`,
      [uuidOrNil(id), vertical ?? null],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Puts a list's items in the given order. */
  async reorderItems(listId: string, ids: string[]): Promise<void> {
    await this.db.query(
      `update todo_items i set position = o.ord, updated_at = now() from unnest($2::uuid[]) with ordinality as o(id, ord)
       where i.id = o.id and i.list_id = $1`,
      [listId, ids.map(uuidOrNil)],
    );
  }
}

/** Non-UUID ids (an agent's typo) match nothing instead of raising a Postgres cast error. */
function uuidOrNil(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "00000000-0000-0000-0000-000000000000";
}

export function reminderRecurrence(r: Reminder): Recurrence | null {
  return r.recurrence ? parseRecurrence(r.recurrence) : null;
}
