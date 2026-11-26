/**
 * Schema for reminders and lists. The server applies it as migration `0007_pa`
 * (apps/server/src/db/migrations.ts); the package's own tests apply it to a
 * scratch schema. Never edit it once applied: add a new migration instead.
 */
export const PA_MIGRATION_ID = "0007_pa";

export const PA_MIGRATION_SQL = `
  create table reminders (
    id uuid primary key,
    text text not null,
    -- Next time it fires. For a recurring reminder, the next occurrence.
    due_at timestamptz not null,
    -- RRULE subset (FREQ=DAILY | FREQ=WEEKLY;BYDAY=.. | FREQ=MONTHLY;BYMONTHDAY=n), null for one-off.
    recurrence text,
    -- Local wall-clock time (HH:MM) and zone occurrences keep across DST changes.
    local_time text not null,
    timezone text not null,
    vertical text not null,
    -- "dave" or "agent".
    created_by text not null,
    task_id uuid,
    -- pending (waiting to fire) | sent (fired, not yet done) | done | cancelled.
    status text not null,
    -- A snooze of a recurring reminder: a one-off re-alert that leaves the series alone.
    snoozed_until timestamptz,
    last_sent_at timestamptz,
    sent_count integer not null default 0,
    completed_at timestamptz,
    -- Bumped on every change, so a delivery only succeeds on the row it read.
    version integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index reminders_due_idx on reminders (status, due_at);
  create index reminders_snooze_idx on reminders (snoozed_until) where snoozed_until is not null;
  create index reminders_vertical_idx on reminders (vertical, status);

  create table todo_lists (
    id uuid primary key,
    vertical text not null,
    name text not null,
    position integer not null default 0,
    created_at timestamptz not null default now()
  );
  create unique index todo_lists_name_idx on todo_lists (vertical, lower(name));

  create table todo_items (
    id uuid primary key,
    list_id uuid not null references todo_lists (id) on delete cascade,
    text text not null,
    done boolean not null default false,
    done_at timestamptz,
    position integer not null,
    due_date date,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create index todo_items_list_idx on todo_items (list_id, done, position);
`;

/** Reminders with a number to call (the Call button). The server applies it after its 0020 migration. */
export const PA_PHONE_MIGRATION_ID = "0021_reminder_phone";
export const PA_PHONE_MIGRATION_SQL = `
  alter table reminders add column if not exists phone text;
`;

/**
 * One list per business, with nested sections, and reminders folded into to-dos.
 * The server applies it after its 0030 migration.
 *
 * - `todo_lists` rows are now sections of their vertical's list: `parent_id` nests
 *   them (null: a top-level section). Names are unique among siblings.
 * - `todo_items` carry their own `vertical` and may sit at the top of the business's
 *   list (`list_id` null).
 * - A reminder is a to-do with a time (`remind_at`). Every open or done reminder is
 *   moved across keeping its id, so links in notifications already sent still work;
 *   cancelled ones are dropped. The old table is kept as `reminders_pre_0031`.
 */
export const PA_TODO_TREE_MIGRATION_ID = "0031_todo_tree_reminders";
export const PA_TODO_TREE_MIGRATION_SQL = `
  alter table todo_lists add column if not exists parent_id uuid references todo_lists (id) on delete cascade;
  drop index if exists todo_lists_name_idx;
  create unique index todo_lists_name_idx on todo_lists (vertical, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
  create index if not exists todo_lists_parent_idx on todo_lists (parent_id);

  alter table todo_items add column if not exists vertical text;
  update todo_items i set vertical = l.vertical from todo_lists l where l.id = i.list_id and i.vertical is null;
  alter table todo_items alter column vertical set not null;
  alter table todo_items alter column list_id drop not null;
  alter table todo_items
    -- The reminder: when it next fires (for a recurring one, the next occurrence). Null: no reminder.
    add column if not exists remind_at timestamptz,
    -- RRULE subset, as reminders had; null for a one-off.
    add column if not exists recurrence text,
    -- Local wall-clock time (HH:MM) and zone occurrences keep across DST changes.
    add column if not exists local_time text,
    add column if not exists timezone text,
    -- pending (waiting to fire) | sent (fired, not yet done). Done is the item's own done flag.
    add column if not exists remind_state text,
    add column if not exists snoozed_until timestamptz,
    add column if not exists last_sent_at timestamptz,
    add column if not exists sent_count integer not null default 0,
    add column if not exists phone text,
    add column if not exists task_id uuid,
    -- Bumped on every change, so a delivery only succeeds on the row it read.
    add column if not exists version integer not null default 0;
  create index if not exists todo_items_vertical_idx on todo_items (vertical, list_id, done, position);
  create index if not exists todo_items_remind_idx on todo_items (remind_state, remind_at) where remind_at is not null and not done;
  create index if not exists todo_items_snooze_idx on todo_items (snoozed_until) where snoozed_until is not null;

  insert into todo_items (id, list_id, vertical, text, done, done_at, position, created_by, created_at, updated_at,
    remind_at, recurrence, local_time, timezone, remind_state, snoozed_until, last_sent_at, sent_count, phone, task_id, version)
  select r.id, null, r.vertical, r.text, r.status = 'done', r.completed_at,
    (row_number() over (partition by r.vertical order by r.created_at))::integer - 1, r.created_by, r.created_at, r.updated_at,
    r.due_at, r.recurrence, r.local_time, r.timezone, case when r.status = 'sent' then 'sent' else 'pending' end,
    r.snoozed_until, r.last_sent_at, r.sent_count, r.phone, r.task_id, r.version
  from reminders r where r.status in ('pending', 'sent', 'done');
  alter table reminders rename to reminders_pre_0031;
`;
