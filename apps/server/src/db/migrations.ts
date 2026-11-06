import { BRAIN_MIGRATION_ID, BRAIN_MIGRATION_SQL } from "@cc/brain";
import { PA_MIGRATION_ID, PA_MIGRATION_SQL, PA_PHONE_MIGRATION_ID, PA_PHONE_MIGRATION_SQL } from "@cc/pa";

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
  // --- pa: reminders, to-do lists and items (SQL lives in @cc/pa) ---
  { id: PA_MIGRATION_ID, sql: PA_MIGRATION_SQL },
  // --- end pa ---
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
  {
    // "uploading": a direct upload claimed by one request (one-shot PUT, or a chunk in flight).
    id: "0012_storage_uploading",
    sql: `
  alter table storage_files drop constraint if exists storage_files_status_check;
  alter table storage_files add constraint storage_files_status_check check (status in ('pending', 'uploading', 'ready'));
`,
  },
  // --- end storage ---
  // --- integrations: credentials managed on the Accounts page (src/integrations) ---
  {
    id: "0013_integrations",
    sql: `
  create table integration_entries (
    kind text not null,
    id text not null,
    -- Non-secret fields (handles, hosts, verticals, calendar picks).
    data jsonb not null default '{}',
    -- Secret fields as one AES-256-GCM blob (src/integrations/secrets.ts); never sent to the browser.
    secrets_enc text,
    -- Status the server keeps: last test, expiry, connected account name.
    meta jsonb not null default '{}',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (kind, id)
  );
  create table integration_audit (
    id bigserial primary key,
    at timestamptz not null default now(),
    actor text not null,
    kind text not null,
    entry_id text not null,
    action text not null
  );
  create table oauth_states (
    state text primary key,
    provider text not null,
    actor text not null,
    data jsonb not null default '{}',
    expires_at timestamptz not null
  );
`,
  },
  // --- end integrations ---
  // brain: notes and their version history (packages/brain/src/pg.ts)
  { id: BRAIN_MIGRATION_ID, sql: BRAIN_MIGRATION_SQL },
  // org: role and policy changes made on the Org page, over the code manifests (src/org-config.ts)
  {
    id: "0015_org_overrides",
    sql: `
  create table org_overrides (
    -- A vertical id, or 'chief-of-staff'.
    unit text primary key,
    data jsonb not null,
    -- Matches org_override_versions.version of the latest save.
    version integer not null,
    updated_by text not null,
    updated_at timestamptz not null default now()
  );
  -- Every save and reset, so an earlier org can be read or restored.
  create table org_override_versions (
    id bigserial primary key,
    unit text not null,
    version integer not null,
    -- Null for a reset to the code manifest.
    data jsonb,
    author text not null,
    created_at timestamptz not null default now(),
    unique (unit, version)
  );
`,
  },
  {
    // Hand-backs: a role's report on work handed to it continues the task that handed it off.
    id: "0016_task_reply_author",
    sql: `
      -- Who wrote a task reply: "dave", or the role that reports back (e.g. "the Shop Lead (Desktop Machine Shop)").
      alter table task_replies add column if not exists author text not null default 'dave';
    `,
  },
  {
    // desktop: computers linked by signing in from the desktop app (src/desktop.ts). Each has its own worker token.
    id: "0017_desktop_devices",
    sql: `
      create table desktop_devices (
        id uuid primary key,
        name text not null,
        -- Who approved the link (null if linked with the admin token).
        user_id uuid references users (id) on delete set null,
        -- sha256 of the device's worker token; the token itself is only ever on the computer.
        token_hash text not null unique,
        -- The worker node this device last connected as.
        node_id text,
        created_at timestamptz not null default now(),
        last_used_at timestamptz,
        revoked_at timestamptz
      );
    `,
  },
  {
    // Device roles (packages/core/src/setup.ts): what each computer has installed, and jobs for one computer only.
    id: "0018_node_setup",
    sql: `
      -- What the worker reported about its setup: platform, installer (winget) and installed components.
      alter table worker_nodes add column if not exists setup jsonb;
      -- A job only this node may run (setup.install); null for jobs any capable node can take.
      alter table jobs add column if not exists target_node_id text;
    `,
  },
  {
    // Files attached to a reply in the chat box (src/chat-files.ts).
    id: "0019_task_reply_files",
    sql: `
      -- {files: [{id, name, contentType, size}], prompt}: the files and the block the agent gets with the reply.
      alter table task_replies add column if not exists files jsonb;
    `,
  },
  {
    // Batches: related proposals (one message per open delivery order) approved or rejected once (src/actions.ts).
    id: "0020_proposal_batches",
    sql: `
      alter table proposals add column if not exists batch_id uuid;
      -- The batch's one-line summary, on each of its items.
      alter table proposals add column if not exists batch_summary text;
      create index if not exists proposals_batch_idx on proposals (batch_id) where batch_id is not null;
      -- "followup": a later note from the role that handed this task off (Pipeline.handoff), not a report back.
      alter table task_replies add column if not exists kind text;
    `,
  },
  // A number to call on a reminder (SQL in @cc/pa).
  { id: PA_PHONE_MIGRATION_ID, sql: PA_PHONE_MIGRATION_SQL },
  {
    // Storage by vertical, and work-in-progress files cleared once the final file is published (packages/storage).
    id: "0022_storage_vertical",
    sql: `
      -- The vertical a file belongs to (null: shared); on Drive it sits in that vertical's folder.
      alter table storage_files add column if not exists vertical text;
      -- The piece of work it belongs to (e.g. "video:<production id>"), and whether it is an intermediate file of it.
      alter table storage_files add column if not exists work text;
      alter table storage_files add column if not exists wip boolean not null default false;
      create index if not exists storage_files_vertical_idx on storage_files (vertical, created_at desc);
      create index if not exists storage_files_work_idx on storage_files (work) where work is not null;

      -- Existing files: the vertical of whatever names them (a proposal, a chat message, a reply, a video job).
      update storage_files f set vertical = (
        select p.vertical from proposals p where p.payload::text like '%' || split_part(f.id, '.', 1) || '%' order by p.created_at limit 1
      ) where f.vertical is null;
      update storage_files f set vertical = (
        select t.vertical from events e join tasks t on t.event_id = e.id
        where e.payload::text like '%' || split_part(f.id, '.', 1) || '%' order by t.created_at limit 1
      ) where f.vertical is null;
      update storage_files f set vertical = (
        select t.vertical from task_replies r join tasks t on t.id = r.task_id
        where r.files::text like '%' || split_part(f.id, '.', 1) || '%' order by r.created_at limit 1
      ) where f.vertical is null;
      update storage_files f set vertical = (
        select j.payload->'spec'->>'product' from jobs j
        where j.kind like 'video.%' and j.payload::text like '%' || split_part(f.id, '.', 1) || '%' order by j.created_at limit 1
      ) where f.vertical is null;
      -- A vertical that isn't a plain id (e.g. a free-text product) is left shared.
      update storage_files set vertical = null where vertical is not null and vertical !~ '^[a-z0-9][a-z0-9-]{0,39}$';

      -- Video files are named "<spec>-<production id>/<file>": captures (.webm) and narration (voice-*) are
      -- work in progress, the render (<spec>.mp4) is the final file.
      update storage_files set
        work = 'video:' || substring(name from '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/'),
        wip = (name ~ '/voice-' or name ~ '[.]webm$')
      where work is null and folder = 'renders' and name ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/';
    `,
  },
  {
    // Pictures and videos a notification is about, shown in the notification centre and briefing view.
    id: "0023_notification_media",
    sql: `
      -- [{url, type: "image" | "video", alt?, durationSec?, width?, height?}]
      alter table notifications add column if not exists media jsonb not null default '[]';
    `,
  },
  {
    // The server's own warnings and errors, for the Software Lead's daily assessment (./ops.ts). Kept 14 days.
    id: "0024_server_log",
    sql: `
      create table if not exists server_log (
        id bigserial primary key,
        level text not null,
        message text not null,
        at timestamptz not null default now()
      );
      create index if not exists server_log_at_idx on server_log (at desc);
    `,
  },
];
