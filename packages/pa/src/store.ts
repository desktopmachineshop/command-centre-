import { randomUUID } from "node:crypto";
import { formatRecurrence, parseRecurrence, type Recurrence } from "./recurrence";

/** What PgPaStore needs from a pg Pool (or client): parameterised queries. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export type CreatedBy = "dave" | "agent";
/** A reminder's state: waiting to fire, fired but not done, or done (the to-do is ticked off). */
export type ReminderStatus = "pending" | "sent" | "done" | "cancelled";

/**
 * A reminder: a to-do with a time. `id` is the to-do's id; `dueAt` is when it
 * next fires and `completedAt` when the to-do was ticked off.
 */
export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  recurrence: string | null;
  localTime: string;
  timeZone: string;
  vertical: string;
  /** The section it is filed in, or null for the top of the business's list. */
  listId: string | null;
  listName: string | null;
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

/**
 * A section of a business's list. Each vertical has one list; its sections nest
 * (`parentId`) as deep as wanted, and items sit in a section or at the top.
 */
export interface TodoList {
  id: string;
  vertical: string;
  name: string;
  /** Null for a top-level section. */
  parentId: string | null;
  /** "Accounting / Invoices": the names from the top section down. */
  path: string;
  position: number;
  openCount: number;
  doneCount: number;
  createdAt: string;
}

export interface TodoItem {
  id: string;
  /** Its section, or null for the top of the business's list. */
  listId: string | null;
  /** The section's path ("Accounting / Invoices"), or null at the top. */
  listName: string | null;
  vertical: string;
  text: string;
  done: boolean;
  doneAt: string | null;
  position: number;
  dueDate: string | null;
  createdBy: CreatedBy;
  createdAt: string;
  updatedAt: string;
  /** Its reminder, when it has a time set. */
  reminder: Reminder | null;
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
  dueAt: iso(r.remind_at)!,
  recurrence: r.recurrence,
  localTime: r.local_time,
  timeZone: r.timezone,
  vertical: r.vertical,
  listId: r.list_id ?? null,
  listName: r.list_name ?? null,
  createdBy: r.created_by,
  taskId: r.task_id,
  status: r.done ? "done" : r.remind_state ?? "pending",
  snoozedUntil: iso(r.snoozed_until),
  lastSentAt: iso(r.last_sent_at),
  sentCount: r.sent_count,
  completedAt: iso(r.done_at),
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  version: r.version,
  phone: r.phone ?? null,
});

const toList = (r: Row): TodoList => ({
  id: r.id,
  vertical: r.vertical,
  name: r.name,
  parentId: r.parent_id ?? null,
  path: r.path ?? r.name,
  position: r.position,
  openCount: Number(r.open_count ?? 0),
  doneCount: Number(r.done_count ?? 0),
  createdAt: iso(r.created_at)!,
});

const toItem = (r: Row): TodoItem => ({
  id: r.id,
  listId: r.list_id ?? null,
  listName: r.list_name ?? null,
  vertical: r.vertical,
  text: r.text,
  done: r.done,
  doneAt: iso(r.done_at),
  position: r.position,
  dueDate: date(r.due_date),
  createdBy: r.created_by,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
  reminder: r.remind_at ? toReminder(r) : null,
});

/** Every section's path ("A / B") and a sort key that walks the tree in order. */
const PATHS = `with recursive paths (id, path, sort) as (
    select id, name::text, lpad(position::text, 8, '0') || id::text from todo_lists where parent_id is null
    union all
    select l.id, p.path || ' / ' || l.name, p.sort || '/' || lpad(l.position::text, 8, '0') || l.id::text
    from todo_lists l join paths p on l.parent_id = p.id
  )`;
const ITEM_SELECT = `${PATHS} select i.*, p.path as list_name from todo_items i left join paths p on p.id = i.list_id`;
const REMINDER_SELECT = `${ITEM_SELECT} where i.remind_at is not null`;
/** A section with its own (not its sub-sections') counts. */
const LIST_SELECT = `${PATHS}
  select l.*, p.path, p.sort,
    (select count(*) from todo_items i where i.list_id = l.id and not i.done) as open_count,
    (select count(*) from todo_items i where i.list_id = l.id and i.done) as done_count
  from todo_lists l join paths p on p.id = l.id`;
/** A reminder's state as a status ('done' once the to-do is ticked off). */
const STATUS = `(case when i.done then 'done' else i.remind_state end)`;
const NIL = "00000000-0000-0000-0000-000000000000";

/** "Accounting / Invoices" or "Accounting > Invoices" as its section names. */
export function sectionPath(path: string): string[] {
  return path
    .split(/\s*[/>]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class PaNotFound extends Error {}

/** The open (not finished) reminder states. */
export const OPEN_REMINDER: ReminderStatus[] = ["pending", "sent"];

/**
 * All PA SQL: to-dos (with or without a reminder time) and the sections of each
 * business's list. Every method that takes `vertical` only touches rows of that
 * vertical; undefined means Dave (every vertical).
 */
export class PgPaStore {
  constructor(private readonly db: Queryable) {}

  // --- Reminders (to-dos with a time) ---

  /** A new to-do with a reminder, at the top of the business's list or in section `listId`. */
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
    listId?: string | null;
  }): Promise<Reminder> {
    const id = randomUUID();
    await this.db.query(
      `insert into todo_items (id, list_id, vertical, text, position, created_by, remind_at, recurrence, local_time, timezone, remind_state, task_id, phone)
       values ($1, $2, $3, $4, ${NEXT_POSITION}, $5, $6, $7, $8, $9, 'pending', $10, $11)`,
      [id, r.listId ?? null, r.vertical, r.text, r.createdBy, r.dueAt, r.recurrence ? formatRecurrence(r.recurrence) : null, r.localTime, r.timeZone, r.taskId ?? null, r.phone ?? null],
    );
    return (await this.getReminder(id))!;
  }

  /** The reminder on to-do `id` (null if it has no time set). */
  async getReminder(id: string, vertical?: string): Promise<Reminder | null> {
    const { rows } = await this.db.query(`${REMINDER_SELECT} and i.id = $1 and ($2::text is null or i.vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return rows[0] ? toReminder(rows[0]) : null;
  }

  /** Reminders by status (default: open), soonest first. */
  async listReminders(options: { vertical?: string; statuses?: ReminderStatus[]; dueBefore?: Date; limit?: number } = {}): Promise<Reminder[]> {
    const { rows } = await this.db.query(
      `${REMINDER_SELECT}
         and ${STATUS} = any($1) and ($2::text is null or i.vertical = $2)
         and ($3::timestamptz is null or least(i.remind_at, coalesce(i.snoozed_until, i.remind_at)) < $3)
       order by least(i.remind_at, coalesce(i.snoozed_until, i.remind_at)), i.created_at limit $4`,
      [options.statuses ?? OPEN_REMINDER, options.vertical ?? null, options.dueBefore ?? null, options.limit ?? 100],
    );
    return rows.map(toReminder);
  }

  /** Ticks the to-do off (for a recurring reminder, the series ends). */
  async completeReminder(id: string, vertical?: string): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update todo_items i set done = true, done_at = now(), snoozed_until = null, updated_at = now(), version = version + 1
       where id = $1 and remind_at is not null and not done and ($2::text is null or vertical = $2) returning id`,
      [uuidOrNil(id), vertical ?? null],
    );
    return rows[0] ? this.getReminder(id) : null;
  }

  /**
   * "Done" on the alert for the occurrence due at `dueAt` (null if it has moved on).
   * A one-off is ticked off; a recurring one only acknowledges this occurrence (clears
   * any snooze) and its series stays pending.
   */
  async acknowledgeReminder(id: string, dueAt: Date): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update todo_items set
         done = recurrence is null,
         done_at = case when recurrence is null then now() else done_at end,
         snoozed_until = null, updated_at = now(), version = version + 1
       where id = $1 and not done and remind_at = $2 returning id`,
      [uuidOrNil(id), dueAt],
    );
    return rows[0] ? this.getReminder(id) : null;
  }

  /**
   * Changes an open to-do's text and/or reminder. With `schedule` the reminder is
   * set there (added if the to-do had none) and is pending again, any snooze cleared;
   * without it only the text (and phone) change, and only on a to-do that has a reminder.
   * `phone`: undefined keeps the number, null removes it.
   */
  async updateReminder(
    id: string,
    patch: { text: string; phone?: string | null; schedule?: { dueAt: Date; recurrence: Recurrence | null; localTime: string; timeZone?: string } },
    vertical?: string,
  ): Promise<Reminder | null> {
    const s = patch.schedule;
    const { rows } = await this.db.query(
      `update todo_items set
         text = $2,
         remind_at = coalesce($3, remind_at),
         recurrence = case when $6 then $4 else recurrence end,
         local_time = coalesce($5, local_time),
         timezone = coalesce($10, timezone),
         remind_state = case when $6 then 'pending' else remind_state end,
         snoozed_until = case when $6 then null else snoozed_until end,
         phone = case when $8 then $9 else phone end,
         updated_at = now(), version = version + 1
       where id = $1 and not done and ($6 or remind_at is not null) and ($7::text is null or vertical = $7) returning id`,
      [
        uuidOrNil(id),
        patch.text,
        s?.dueAt ?? null,
        s?.recurrence ? formatRecurrence(s.recurrence) : null,
        s?.localTime ?? null,
        !!s,
        vertical ?? null,
        patch.phone !== undefined,
        patch.phone ?? null,
        s?.timeZone ?? null,
      ],
    );
    return rows[0] ? this.getReminder(id) : null;
  }

  /**
   * Takes the reminder off an open to-do; the to-do itself stays on its list.
   * Returns the reminder as it was (null if there was no open one).
   */
  async cancelReminder(id: string, vertical?: string): Promise<Reminder | null> {
    const before = await this.getReminder(id, vertical);
    if (!before || !OPEN_REMINDER.includes(before.status)) return null;
    const { rowCount } = await this.db.query(
      `update todo_items set remind_at = null, recurrence = null, local_time = null, timezone = null, remind_state = null,
         snoozed_until = null, phone = null, updated_at = now(), version = version + 1
       where id = $1 and version = $2`,
      [before.id, before.version],
    );
    return (rowCount ?? 0) > 0 ? { ...before, status: "cancelled" } : null;
  }

  /**
   * Snooze until `until`. A one-off reminder simply moves (and is pending again);
   * a recurring one gets a one-off re-alert and its series stays on schedule.
   */
  async snoozeReminder(id: string, until: Date, vertical?: string, dueAt?: Date): Promise<Reminder | null> {
    const { rows } = await this.db.query(
      `update todo_items set
         remind_at = case when recurrence is null then $2 else remind_at end,
         snoozed_until = case when recurrence is null then null else $2 end,
         remind_state = case when recurrence is null then 'pending' else remind_state end,
         updated_at = now(), version = version + 1
       where id = $1 and remind_at is not null and not done and ($3::text is null or vertical = $3) and ($4::timestamptz is null or remind_at = $4) returning id`,
      [uuidOrNil(id), until, vertical ?? null, dueAt ?? null],
    );
    return rows[0] ? this.getReminder(id) : null;
  }

  /** Reminders whose time (or snooze) has come. */
  async dueReminders(now: Date, limit = 50): Promise<Reminder[]> {
    const { rows } = await this.db.query(
      `${REMINDER_SELECT} and not i.done
         and ((i.remind_state = 'pending' and i.remind_at <= $1) or i.snoozed_until <= $1)
       order by least(i.remind_at, coalesce(i.snoozed_until, i.remind_at)) limit $2`,
      [now, limit],
    );
    return rows.map(toReminder);
  }

  /**
   * Records a delivery, only if the row is unchanged since it was read
   * (`version`), so two replicas can't both send it. False: someone else won.
   */
  async markReminderSent(r: Reminder, next: { status: ReminderStatus; dueAt: Date; snoozedUntil: Date | null }, now: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `update todo_items set remind_state = $3, remind_at = $4, snoozed_until = $5, last_sent_at = $6, sent_count = sent_count + 1, updated_at = now(), version = version + 1
       where id = $1 and version = $2`,
      [r.id, r.version, next.status, next.dueAt, next.snoozedUntil, now],
    );
    return (rowCount ?? 0) > 0;
  }

  // --- Sections ---

  /** Sections in tree order (each followed by its sub-sections), by vertical. */
  async listLists(vertical?: string): Promise<TodoList[]> {
    const { rows } = await this.db.query(`${LIST_SELECT} where ($1::text is null or l.vertical = $1) order by l.vertical, p.sort`, [vertical ?? null]);
    return rows.map(toList);
  }

  async getList(id: string, vertical?: string): Promise<TodoList | null> {
    const { rows } = await this.db.query(`${LIST_SELECT} where l.id = $1 and ($2::text is null or l.vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return rows[0] ? toList(rows[0]) : null;
  }

  /** The section at `path` ("Accounting / Invoices", case-insensitive), or null. */
  async findList(vertical: string, path: string): Promise<TodoList | null> {
    const exact = await this.db.query(`${LIST_SELECT} where l.vertical = $1 and lower(p.path) = lower($2)`, [vertical, path.trim()]);
    if (exact.rows[0]) return toList(exact.rows[0]);
    const { rows } = await this.db.query(`${LIST_SELECT} where l.vertical = $1 and lower(p.path) = lower($2)`, [vertical, sectionPath(path).join(" / ")]);
    return rows[0] ? toList(rows[0]) : null;
  }

  /**
   * The section at `path` in the vertical (case-insensitive), creating any part
   * of it that is missing. Under `parentId` when given, `path` is one name.
   */
  async ensureList(vertical: string, path: string, parentId: string | null = null): Promise<TodoList> {
    if (!parentId) {
      const found = await this.findList(vertical, path);
      if (found) return found;
    }
    const names = parentId ? [path.trim()] : sectionPath(path);
    if (!names.length || names.some((n) => !n)) throw new Error("list name must not be empty");
    if (parentId && !(await this.getList(parentId, vertical))) throw new PaNotFound("no such section");
    let parent = parentId;
    let list: TodoList | null = null;
    for (const name of names) {
      await this.db.query(
        `insert into todo_lists (id, vertical, name, parent_id, position)
         values ($1, $2, $3, $4, (select coalesce(max(position), -1) + 1 from todo_lists where vertical = $2 and parent_id is not distinct from $4))
         on conflict (vertical, coalesce(parent_id, '${NIL}'::uuid), lower(name)) do nothing`,
        [randomUUID(), vertical, name, parent],
      );
      const { rows } = await this.db.query(`${LIST_SELECT} where l.vertical = $1 and l.parent_id is not distinct from $2 and lower(l.name) = lower($3)`, [
        vertical,
        parent,
        name,
      ]);
      list = toList(rows[0]);
      parent = list.id;
    }
    return list!;
  }

  async renameList(id: string, name: string, vertical?: string): Promise<TodoList | null> {
    const { rows } = await this.db.query(`update todo_lists set name = $2 where id = $1 and ($3::text is null or vertical = $3) returning id`, [
      uuidOrNil(id),
      name.trim(),
      vertical ?? null,
    ]);
    return rows[0] ? this.getList(id) : null;
  }

  /** Deletes a section with its sub-sections and their items. */
  async deleteList(id: string, vertical?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(`delete from todo_lists where id = $1 and ($2::text is null or vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return (rowCount ?? 0) > 0;
  }

  /** Puts sections in the given order among their siblings (ids not given keep their place after them). */
  async reorderLists(ids: string[], vertical?: string): Promise<void> {
    await this.db.query(
      `update todo_lists l set position = o.ord from unnest($1::uuid[]) with ordinality as o(id, ord)
       where l.id = o.id and ($2::text is null or l.vertical = $2)`,
      [ids.map(uuidOrNil), vertical ?? null],
    );
  }

  // --- Items ---

  /** Adds to-dos to section `listId`, or to the top of `vertical`'s list when `listId` is null. */
  async addItems(where: string | { vertical: string; listId: string | null }, items: { text: string; dueDate?: string | null }[], createdBy: CreatedBy): Promise<TodoItem[]> {
    if (!items.length) return [];
    let target: { vertical: string; listId: string | null };
    if (typeof where === "string") {
      const list = await this.getList(where);
      if (!list) throw new PaNotFound("no such section");
      target = { vertical: list.vertical, listId: list.id };
    } else target = where;
    const ids = items.map(() => randomUUID());
    await this.db.query(
      `insert into todo_items (id, list_id, vertical, text, position, due_date, created_by)
       select x.id, $2, $6, x.text,
         (select coalesce(max(position), -1) from todo_items where vertical = $6 and list_id is not distinct from $2) + x.ord,
         x.due::date, $3
       from unnest($1::uuid[], $4::text[], $5::text[]) with ordinality as x(id, text, due, ord)`,
      [ids, target.listId, createdBy, items.map((i) => i.text.trim()), items.map((i) => i.dueDate ?? null), target.vertical],
    );
    const { rows } = await this.db.query(`${ITEM_SELECT} where i.id = any($1) order by i.position`, [ids]);
    return rows.map(toItem);
  }

  async getItem(id: string, vertical?: string): Promise<TodoItem | null> {
    const { rows } = await this.db.query(`${ITEM_SELECT} where i.id = $1 and ($2::text is null or i.vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  /**
   * A section's items (null with `vertical`: the top of that business's list):
   * open ones in order, then (if asked) recently done ones. `descendants` adds
   * the items of its sub-sections, in tree order.
   */
  async listItems(listId: string | null, options: { vertical?: string; includeDone?: boolean; limit?: number; descendants?: boolean } = {}): Promise<TodoItem[]> {
    const { rows } = await this.db.query(
      `${ITEM_SELECT}
       where ($5::text is null or i.vertical = $5)
         and (case when $1::uuid is null then i.list_id is null
                   when $4 then p.sort like (select sort from paths where id = $1) || '%'
                   else i.list_id = $1 end)
         and ($2 or not i.done)
       order by i.done, case when i.done then null else p.sort end nulls first, case when i.done then null else i.position end, i.done_at desc nulls last
       limit $3`,
      [listId === null ? null : uuidOrNil(listId), options.includeDone ?? false, options.limit ?? 200, options.descendants ?? false, options.vertical ?? null],
    );
    return rows.map(toItem);
  }

  /** Every item of the vertical (or all), open ones first, done ones from the last 30 days: for building the whole tree at once. */
  async allItems(options: { vertical?: string; includeDone?: boolean; limit?: number } = {}): Promise<TodoItem[]> {
    const { rows } = await this.db.query(
      `${ITEM_SELECT} where ($1::text is null or i.vertical = $1) and (not i.done or ($2 and i.done_at > now() - interval '30 days'))
       order by i.done, case when i.done then null else i.position end, i.done_at desc nulls last limit $3`,
      [options.vertical ?? null, options.includeDone ?? false, options.limit ?? 2000],
    );
    return rows.map(toItem);
  }

  /**
   * The top open items across lists: overdue or due today first (by due date),
   * then the "today" section, then the rest in list order.
   */
  async topItems(options: { vertical?: string; today: string; limit?: number }): Promise<TodoItem[]> {
    const { rows } = await this.db.query(
      `${ITEM_SELECT} where not i.done and ($1::text is null or i.vertical = $1)
       order by (i.due_date is not null and i.due_date <= $2::date) desc, i.due_date nulls last,
                (lower(coalesce(p.path, '')) = 'today') desc, i.vertical, p.sort nulls first, i.position
       limit $3`,
      [options.vertical ?? null, options.today, options.limit ?? 10],
    );
    return rows.map(toItem);
  }

  async setItemDone(id: string, done: boolean, vertical?: string): Promise<TodoItem | null> {
    const { rows } = await this.db.query(
      `update todo_items set done = $2, done_at = case when $2 then now() else null end,
         snoozed_until = case when $2 then null else snoozed_until end, updated_at = now(), version = version + 1
       where id = $1 and ($3::text is null or vertical = $3) returning id`,
      [uuidOrNil(id), done, vertical ?? null],
    );
    return rows[0] ? this.getItem(id) : null;
  }

  async updateItem(id: string, patch: { text?: string; dueDate?: string | null }, vertical?: string): Promise<TodoItem | null> {
    const { rows } = await this.db.query(
      `update todo_items set text = coalesce($2, text), due_date = case when $3 then $4::date else due_date end, updated_at = now(), version = version + 1
       where id = $1 and ($5::text is null or vertical = $5) returning id`,
      [uuidOrNil(id), patch.text?.trim() ?? null, patch.dueDate !== undefined, patch.dueDate ?? null, vertical ?? null],
    );
    return rows[0] ? this.getItem(id) : null;
  }

  /** Moves an item to section `listId` of its own vertical (null: the top of the list), at the end. */
  async moveItem(id: string, listId: string | null, vertical?: string): Promise<TodoItem | null> {
    const item = await this.getItem(id, vertical);
    if (!item) return null;
    if (listId && !(await this.getList(listId, item.vertical))) throw new PaNotFound("no such section in that business");
    await this.db.query(
      `update todo_items set list_id = $2,
         position = (select coalesce(max(position), -1) + 1 from todo_items where vertical = $3 and list_id is not distinct from $2::uuid),
         updated_at = now(), version = version + 1
       where id = $1`,
      [item.id, listId, item.vertical],
    );
    return this.getItem(id);
  }

  async deleteItem(id: string, vertical?: string): Promise<boolean> {
    const { rowCount } = await this.db.query(`delete from todo_items where id = $1 and ($2::text is null or vertical = $2)`, [uuidOrNil(id), vertical ?? null]);
    return (rowCount ?? 0) > 0;
  }

  /** Puts a section's items in the given order. */
  async reorderItems(listId: string, ids: string[]): Promise<void> {
    await this.db.query(
      `update todo_items i set position = o.ord, updated_at = now(), version = version + 1 from unnest($2::uuid[]) with ordinality as o(id, ord)
       where i.id = o.id and i.list_id = $1`,
      [listId, ids.map(uuidOrNil)],
    );
  }
}

/** The next position at the end of ($3 vertical, $2 section): used by inserts. */
const NEXT_POSITION = `(select coalesce(max(position), -1) + 1 from todo_items where vertical = $3 and list_id is not distinct from $2::uuid)`;

/** Non-UUID ids (an agent's typo) match nothing instead of raising a Postgres cast error. */
function uuidOrNil(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "00000000-0000-0000-0000-000000000000";
}

export function reminderRecurrence(r: Reminder): Recurrence | null {
  return r.recurrence ? parseRecurrence(r.recurrence) : null;
}
