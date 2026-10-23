/**
 * Ordered schema migrations. Append new entries; never edit an applied one.
 * Kept in code (not .sql files) so the bundled server carries them.
 */
export const migrations: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
      create table events (
        id uuid primary key,
        source text not null,
        vertical text,
        kind text not null,
        title text not null,
        payload jsonb not null default '{}',
        dedupe_key text unique,
        received_at timestamptz not null default now()
      );
      create index events_received_idx on events (received_at desc);

      create table tasks (
        id uuid primary key,
        event_id uuid not null references events (id) on delete cascade,
        vertical text not null,
        intent text not null,
        route text not null,
        urgency real not null,
        status text not null,
        prompt text not null,
        triage jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index tasks_status_idx on tasks (status, created_at desc);

      create table agent_runs (
        id uuid primary key,
        task_id uuid not null references tasks (id) on delete cascade,
        runner text not null,
        status text not null,
        result text,
        error text,
        cost_usd double precision,
        session_id text,
        started_at timestamptz not null default now(),
        finished_at timestamptz
      );
      create index agent_runs_task_idx on agent_runs (task_id, started_at);

      create table run_messages (
        id bigserial primary key,
        run_id uuid not null references agent_runs (id) on delete cascade,
        message jsonb not null,
        created_at timestamptz not null default now()
      );
      create index run_messages_run_idx on run_messages (run_id, id);

      create table proposals (
        id uuid primary key,
        task_id uuid references tasks (id) on delete set null,
        vertical text not null,
        action_type text not null,
        summary text not null,
        payload jsonb not null default '{}',
        policy text not null,
        status text not null,
        result jsonb,
        created_at timestamptz not null default now(),
        decided_at timestamptz
      );
      create index proposals_status_idx on proposals (status, created_at desc);

      create table push_subscriptions (
        endpoint text primary key,
        subscription jsonb not null,
        created_at timestamptz not null default now()
      );

      create table worker_nodes (
        id text primary key,
        name text not null,
        capabilities text[] not null default '{}',
        online boolean not null default false,
        last_seen timestamptz not null default now()
      );

      create table jobs (
        id uuid primary key,
        kind text not null,
        requires text[] not null default '{}',
        payload jsonb not null default '{}',
        status text not null,
        node_id text references worker_nodes (id) on delete set null,
        progress real,
        result jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index jobs_status_idx on jobs (status, created_at);
    `,
  },
  {
    id: "0002_email_checkpoints",
    sql: `
      -- Last ingested IMAP UID per email account, valid for one UIDVALIDITY.
      create table email_checkpoints (
        account_id text primary key,
        uid_validity text not null,
        last_uid bigint not null,
        updated_at timestamptz not null default now()
      );
    `,
  },
  {
    id: "0003_budgets_digests",
    sql: `
      alter table tasks add column note text;
      alter table tasks add column duplicate_of uuid references tasks (id) on delete set null;
      -- Set by an explicit retry; the next run ignores the budget once and clears it.
      alter table tasks add column budget_override boolean not null default false;
      create index tasks_vertical_status_idx on tasks (vertical, status);
      create index tasks_dedupe_idx on tasks (vertical, md5(prompt), created_at desc);
      create index agent_runs_started_idx on agent_runs (started_at);
      create index proposals_vertical_idx on proposals (vertical, decided_at);

      -- One push per budget scope per day, shared across replicas and restarts.
      create table budget_alerts (
        day date not null,
        scope text not null,
        created_at timestamptz not null default now(),
        primary key (day, scope)
      );
    `,
  },
];
