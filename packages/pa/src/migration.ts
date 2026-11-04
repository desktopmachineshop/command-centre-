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
