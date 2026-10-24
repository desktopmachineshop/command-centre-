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
    // Briefly shipped as 0002_budgets_digests, so databases migrated under that id
    // already have these objects: every statement must be safe to rerun.
    sql: `
      alter table tasks add column if not exists note text;
      alter table tasks add column if not exists duplicate_of uuid references tasks (id) on delete set null;
      -- Set by an explicit retry; the next run ignores the budget once and clears it.
      alter table tasks add column if not exists budget_override boolean not null default false;
      create index if not exists tasks_vertical_status_idx on tasks (vertical, status);
      create index if not exists tasks_dedupe_idx on tasks (vertical, md5(prompt), created_at desc);
      create index if not exists agent_runs_started_idx on agent_runs (started_at);
      create index if not exists proposals_vertical_idx on proposals (vertical, decided_at);

      -- One push per budget scope per day, shared across replicas and restarts.
      create table if not exists budget_alerts (
        day date not null,
        scope text not null,
        created_at timestamptz not null default now(),
        primary key (day, scope)
      );
    `,
  },
  {
    id: "0004_social",
    sql: `
      -- Opaque poll cursor per social account (null: the adapter has none yet).
      create table social_checkpoints (
        account_id text primary key,
        cursor text,
        updated_at timestamptz not null default now()
      );

      -- Posts of an approved social.campaign with publishAt, published by the every-minute system job.
      create table scheduled_posts (
        id uuid primary key,
        campaign_id uuid not null,
        title text not null,
        account_id text not null,
        platform text not null,
        vertical text not null,
        content jsonb not null,
        publish_at timestamptz not null,
        status text not null,
        result jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index scheduled_posts_due_idx on scheduled_posts (status, publish_at);
      create index scheduled_posts_created_idx on scheduled_posts (created_at desc);
    `,
  },
  // --- org roles (docs/ORG.md). 0004 is reserved for the social core. ---
  {
    id: "0005_roles",
    sql: `
      -- The org role that runs the task; null (older tasks) means the vertical lead.
      alter table tasks add column if not exists role text;
      create index if not exists tasks_vertical_role_idx on tasks (vertical, role, status);
    `,
  },
  // --- end org roles ---
  // --- auth (email + password sign-in; see src/accounts) ---
  {
    id: "0006_auth",
    sql: `
      create table users (
        id uuid primary key,
        -- Always stored lower-cased; the check keeps a direct SQL insert honest too.
        email text not null unique check (email = lower(email)),
        name text not null,
        password_hash text not null,
        -- Only 'admin' exists today. Other roles (e.g. a VA) are new values here plus a check in the API.
        role text not null default 'admin',
        created_at timestamptz not null default now(),
        last_login_at timestamptz,
        failed_attempts integer not null default 0,
        locked_until timestamptz,
        -- TOTP: the secret is set by /totp/setup and only enforced once totp_enabled_at is set.
        totp_secret text,
        totp_enabled_at timestamptz,
        -- Last accepted TOTP step, so a code can't be replayed.
        totp_last_step bigint
      );

      -- id is sha256(cookie token); the token itself is never stored.
      create table sessions (
        id text primary key,
        user_id uuid not null references users (id) on delete cascade,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        expires_at timestamptz not null,
        user_agent text,
        ip text
      );
      create index sessions_user_idx on sessions (user_id);
      create index sessions_expires_idx on sessions (expires_at);

      create table user_recovery_codes (
        user_id uuid not null references users (id) on delete cascade,
        code_hash text not null,
        used_at timestamptz,
        primary key (user_id, code_hash)
      );
    `,
  },
  // --- end auth ---
  // --- Odoo events ---
  {
    id: "0009_odoo_events",
    sql: `
      -- One row per Odoo event source (key "<odoo db>:<source>"): a date cursor and the ids
      -- seen in its overlap window, or for stock/deliveries the ids currently low/late.
      create table odoo_event_checkpoints (
        source text primary key,
        cursor text,
        seen_ids integer[] not null default '{}',
        state jsonb not null default '{}',
        updated_at timestamptz not null default now()
      );
      -- The daily digest reads the day's Odoo events per vertical.
      create index events_source_vertical_received_idx on events (source, vertical, received_at);
    `,
  },
  // --- end odoo events ---
  {
    id: "0008_voice",
    sql: `
      -- Voice mode: the structured spoken answer of a run ({text, type: converse | final, structured}).
      alter table agent_runs add column if not exists voice_response jsonb;

      -- Dave's replies continuing a task's conversation; each one drives one more run of the same task.
      create table task_replies (
        id uuid primary key,
        task_id uuid not null references tasks (id) on delete cascade,
        text text not null,
        voice boolean not null default false,
        resume_session_id text,
        run_id uuid references agent_runs (id) on delete set null,
        created_at timestamptz not null default now(),
        consumed_at timestamptz
      );
      create index task_replies_pending_idx on task_replies (task_id, created_at) where consumed_at is null;
    `,
  },
  // --- notifications (0010): inbox, preferences, device metadata; see src/notifications ---
  {
    id: "0010_notifications",
    sql: `
      -- Device metadata on push subscriptions. user_id is 'default' until multi-user login attaches users.
      alter table push_subscriptions add column if not exists id uuid not null default gen_random_uuid();
      create unique index if not exists push_subscriptions_id_idx on push_subscriptions (id);
      alter table push_subscriptions add column if not exists user_id text not null default 'default';
      alter table push_subscriptions add column if not exists name text;
      alter table push_subscriptions add column if not exists platform text;
      alter table push_subscriptions add column if not exists user_agent text;
      -- Lowest priority the device receives ('low' = everything, 'urgent' = urgent only).
      alter table push_subscriptions add column if not exists min_priority text not null default 'low';
      alter table push_subscriptions add column if not exists last_success_at timestamptz;
      alter table push_subscriptions add column if not exists last_failure_at timestamptz;
      alter table push_subscriptions add column if not exists last_error text;

      -- Stored overrides on top of the built-in defaults, per user ('default' for now).
      create table if not exists notification_prefs (
        user_id text primary key,
        prefs jsonb not null default '{}',
        updated_at timestamptz not null default now()
      );

      -- The in-app notification centre: every notification, whether or not it was pushed.
      create table if not exists notifications (
        id uuid primary key,
        user_id text not null default 'default',
        category text not null,
        priority text not null,
        vertical text,
        title text not null,
        body text not null,
        url text,
        tag text,
        actions jsonb not null default '[]',
        data jsonb not null default '{}',
        status text not null,
        created_at timestamptz not null default now(),
        pushed_at timestamptz,
        read_at timestamptz
      );
      create index if not exists notifications_user_created_idx on notifications (user_id, created_at desc);
      create index if not exists notifications_user_status_idx on notifications (user_id, status, category, created_at);
      create index if not exists notifications_unread_idx on notifications (user_id) where read_at is null;

      -- Once-a-day system notification jobs (the quick briefing), shared across replicas and restarts.
      create table if not exists notification_runs (
        user_id text not null,
        job text not null,
        day date not null,
        created_at timestamptz not null default now(),
        primary key (user_id, job, day)
      );
    `,
  },
  // --- end notifications ---
  // --- storage (packages/storage: our public blob id <-> Drive file id or local file) ---
  {
    id: "0011_storage",
    sql: `
  create table if not exists storage_files (
    id text primary key,
    backend text not null check (backend in ('local', 'gdrive')),
    remote_id text,
    name text not null,
    size bigint not null default 0,
    content_type text not null,
    folder text not null,
    status text not null default 'ready' check (status in ('pending', 'ready')),
    upload_url text,
    local_path text,
    created_at timestamptz not null default now()
  );
  create index if not exists storage_files_folder_idx on storage_files (folder, created_at desc);
  create index if not exists storage_files_backend_idx on storage_files (backend, status);
  create table if not exists storage_state (
    key text primary key,
    value text not null
  );
`,
  },
  // --- end storage ---
];
