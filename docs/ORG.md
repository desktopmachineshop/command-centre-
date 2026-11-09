# The assistant and the specialists

Every agent run works as one of two kinds of role:

- **The assistant**: Dave's one assistant, the org root. It takes every task, in every business:
  Dave's chats and voice requests, schedules, and incoming email, Odoo, social and webhooks. It
  does the work itself.
- **A specialist**: an agent with tools the assistant doesn't have, which the assistant hands
  specialist work to. There are three: the **Software Lead** (Command Centre: code changes in its
  own checkout, pull requests), the **Video Producer** and the **Blog Writer** (both 3dpandme).

A role decides what the run sees (skills and MCP servers) and how it behaves (its mission and
autonomy notes go into the system prompt). Roles never change policy: whether an action runs
straight away or waits for Dave is decided by the business's `policies`, and outside input always
makes it a draft. A role's `actions` and `autonomyNotes` only tell the agent what it is expected
to propose, and are shown in the app.

Where it lives:

- the assistant is `chiefOfStaff` in `packages/verticals/src/org.ts`. Its id is still
  `chief-of-staff`, which existing tasks carry; its title is **Assistant** and it answers to
  `assistant`, `cos` and `chief` in chat. Its home business is `personal`, where its own schedules
  (the morning brief) run;
- the specialists are each business's `roles`, in `packages/verticals/src/<vertical>.ts`
  (`command-centre.ts` and `3dpandme.ts`; the other businesses have none);
- what the assistant gets and its charter are in `apps/server/src/assistant.ts`;
- the schema and its checks are in `packages/core/src/vertical.ts` (`Role`, `orgIssues`) and
  `packages/core/src/org.ts`;
- changes made on the Businesses page are stored in Postgres and run over the code (see
  [Editing from the app](#editing-from-the-app)).

The **Businesses** page in the app (route `#/org`) shows the assistant's card, with live numbers
over every business (open tasks, tasks done in the last 7 days, cost over 7 days and approvals
waiting), then each business: its description, a link to its how-we-work note, its budget, its
schedules, its approval policies and its specialists' cards. Choose a card's title to see its tasks
in the Inbox. The same tree is served at `GET /api/org`. A task counts towards the specialist it
names, otherwise towards the assistant (including tasks of roles that no longer exist).

## How a task gets its role

When a task is created, after triage (`routeRole` in `packages/verticals/src/routing.ts`), it goes
to the **assistant**, in the business triage picked, unless:

1. **A specialist is assigned.** A specialist's schedule, a handoff, or the chat API's `role` field
   names it (`payload.role`). Only chat, cron and the server's own events may set this; an email
   can't choose its role.
2. **A specialist is named in chat.** A chat that starts with a specialist's name and a colon goes
   to it: `video: …`, `blog: …`, `software: …`, `3dpandme/blog: …`. The id, an alias or the title
   all work (`Video Producer: …`). Either may move the task to the specialist's business. A name
   several businesses share goes to the triaged business's specialist, and is otherwise ignored.

Any other prefix (`support:`, `pricing:`, `ops:`) is no longer special: the chat goes to the
assistant. The assistant's own names (`assistant:`, `cos:`, `chief:`) go to it too. A business
named first (`dms: …`, or the business picked in the app) still steers triage, so a `dms: …` chat
or a DMS email is a DMS task of the assistant's.

The role is stored on the task (`tasks.role`, migration `0005_roles`) and shown in the Inbox.
`GET /api/tasks?vertical=3dpandme&role=video-producer` lists one role's tasks.

## What a run gets

The assistant's runs depend on where the work came from (`apps/server/src/pipeline.ts`, using
`untrustedSource`):

- **Work Dave started** (chat, schedules, and handoffs from those): every business's MCP servers
  (`assistantServers`: Odoo, mail for every mailbox, Sendcloud parcels, openGym workouts, `pa` for calendar and
  reminders, the brain, `ops`, read-only `github`) and every skill (`assistantSkills`). The run
  token carries the servers and `anyVertical`, so the MCP endpoints allow them, and mail, parcels,
  `list_pending` and `search_transcripts` cover every business. Each proposal names its business
  (`vertical` on `propose_action` / `propose_batch`); that business's policy and budget apply. A
  proposal without one is the task's business.
- **Work from outside input** (an email, a webhook, Odoo, social, or a chat run that has read mail
  or such a transcript): only that business's MCP servers, and every proposal is that business's
  and waits for Dave.

A specialist's runs get its own `mcpServers` (or the business's when it lists none) and its own
skills. The run token carries the role, and `/mcp/<server>` refuses servers it doesn't have.

For every run:

- **Workspace:** `workspaces/<vertical>/<role>`, with only the role's skills linked into
  `.claude/skills` (for the assistant, every skill). Runs of one role can overlap, so the links are
  updated in place, never wiped.
- **System prompt:** for the assistant, its charter (`assistantCharter`): its mission, the
  businesses with their brain folders and how-we-work notes, which business this task is filed
  under, what it may use (trusted or outside input), its autonomy notes and the specialists it can
  hand work to. For a specialist: its title, mission, usual actions and autonomy notes, and the
  roles it can hand work to. Then how the Command Centre works and a one-line guide to each page
  of the app (`agent-context.ts`), and the task's handover note.
- **Help:** every run gets the read-only `help` MCP server: it searches and reads the in-app help
  and the setup notes in `docs/`, so "how do I…" questions are answered from the docs, not guessed
  (see SETUP.md, In-app help).
- **The web:** every run can search the web (`WebSearch`) and, for work Dave started, read pages
  (`WebFetch`). A task from outside input gets search only: a page fetch could carry data out to a
  URL that the input planted. A role's `tools` add more (Bash, Edit, ...) on top.
- **Scratch folder:** for work Dave started, `scratch/<task id>` in the workspace, which the run may
  read, write and edit (and nothing else outside the brain). One per task; folders older than two
  weeks are removed. A task from outside input gets none.
- **Transcripts:** the `actions` tool `search_transcripts` searches earlier runs' messages,
  read-only (every business for the assistant on work Dave started, otherwise the run's own).
  Reading the transcript of a task from outside input counts as reading that input: later
  proposals are drafts. The assistant has no shell, on purpose: it reads outside mail and the web,
  and a shell on the server can read the process environment, which holds every secret.
- **Turns:** each run stops after `AGENT_MAX_TURNS` agent turns (default 30), or the role's own
  `maxTurns` (the Software Lead has 200, since a code change takes many reads, edits and checks). A
  run that hits the limit fails with `error_max_turns`; its report back says it stopped part-way,
  with its last summary, so the assistant offers a retry or a split instead of guessing.
- **Mail:** a run with the `mail` server can search mailboxes and read attachments itself. Mail it
  reads is outside input: its later proposals are drafts and its handoffs carry that (see
  SETUP.md, Email).
- **Concurrency and budgets** stay per business: a task counts against the business it is filed
  under.

## How we work: each business's notes

The old org chart had about twenty roles (a lead per business, Customer Support, Ops & Admin,
Catalogue & Pricing and so on). Their missions and autonomy notes, what good looks like and what
always needs Dave (refunds always need Dave, for example), are kept as each business's `guidance`:

- `packages/verticals/src/how-we-work.ts` (`howWeWork`) turns a business's areas of work (the old
  roles' titles, missions, autonomy notes and KPIs) into markdown. The areas are in each manifest
  (`AREAS` in `dms.ts`, `personal.ts` and `3dpandme.ts`; `saasAreas` in `saas-org.ts` for OpenV and
  OpenD).
- At startup, `seedHowWeWork` (`apps/server/src/how-we-work.ts`) writes it to the brain as
  `<brainFolder>/how-we-work.md` (e.g. `dms/how-we-work.md`), once: only where that path has never
  existed, so Dave's edits, and a note he deleted, stand. If Dave had edited a business's roles on
  the old Org page, the roles he saved (other than today's specialists) are appended under "As you
  last saved them on the Org page", so nothing he wrote is lost.
- From then on the note is Dave's to edit on the Brain page. The assistant's charter names each
  business's note and tells it to read it before working on that business.

## Schedules

- The assistant's own: `morning-brief` (07:00 weekdays, on), in its home business `personal`.
- A business's `schedules` run as the assistant in that business: `dms` `low-stock-check` (off),
  `personal` `evening-wrap` (off); `reddit-scout` (weekdays, on) and `competitor-watch` (Mondays,
  on, skipped while the business's competitor registry is empty) for `dms`, `3dpandme`, `openv`
  and `opend`.
- A specialist's `schedules` run as that specialist: the Software Lead's `file-issues` and
  `assess-performance`.

The scheduler is `apps/server/src/scheduler.ts`. Schedule ids are unique across a business, its
specialists and, for the home business, the assistant.

## Handoffs

Every run has the `actions` tool `handoff_to_role(roleId, note)`. It creates a new task for
another role with the note, the original request and the handing-off task's handover note, and the
agent then stops.

- The assistant hands work to a specialist as `<vertical>/<role>` (`3dpandme/video-producer`). Its
  charter tells it to hand off only specialist work (code changes, a video, a blog post) and do
  everything else itself.
- A specialist may hand work to another specialist in its business, or escalate to
  `chief-of-staff`. Only the assistant hands work across businesses.
- **Loop protection:**
  - at most 3 handoffs in one chain (`MAX_HANDOFF_DEPTH`, `maxHandoffDepth` on the pipeline);
  - never back to a role already in the chain, and never to yourself;
  - one task per handing-off task and target. A second handoff to the same role is a **follow-up**:
    the note goes to that role's task (it waits if the task is running, and runs it again
    otherwise), and the task reports back again. The same note twice sends nothing, there are at
    most 3 follow-ups per task (`MAX_FOLLOW_UPS`), and work from outside input can't send a
    follow-up into a task that has none.

  The system prompt tells the agent how many handoffs are left. At the limit, the tool refuses
  and the agent finishes the work or notifies Dave.
- **Trust carries over:** a handoff task keeps the source of the event that started its chain.
  Work that began with an email or webhook still gets only draft proposals after any number of
  handoffs, and its prompt says the request came from outside.
- Handoffs are internal, so they need no approval and cost nothing until the new task runs.

## Reporting back

When a handed-off task finishes (done, waiting for approval, or failed), its result goes back to
the task that handed it off, as a report (`task_replies.author`, migration `0016`). That task runs
again, resuming its agent's session, and gives the outcome: the assistant tells Dave in the same
chat thread or Converse session ("The Video Producer has the outline ready; the announcement waits
for your approval").

- A report carries the role's final summary, anything waiting for Dave's approval, and its task
  id. The handoff prompt tells the role its summary goes back, so it writes a report.
- **Each step reports once, with the final result:** a task that handed work on waits until all of
  its handoffs have finished and reported before reporting up itself (`Store.openHandoffs`). A
  report that arrives while its task is running waits, and the task runs again for it afterwards.
- Reports are internal, like handoffs; each one costs one more run of the receiving task.

## Editing from the app

On the **Businesses** page, press **Edit**:

- the pencil on a card edits the assistant or that specialist: title, mission, autonomy notes,
  skills, MCP servers, the actions it usually proposes, chat aliases, KPIs and schedules. (The
  assistant's runs get every skill and, for work Dave started, every business's servers whatever
  its card lists.) **Add specialist** adds one to a business, and **Remove** takes one out; its
  tasks then count as the assistant's.
- **Policies** sets, per action type, whether it waits for approval, runs and is listed in the
  digest, or runs straight away. Outside input still always makes a draft.
- **History** lists every save, with **Restore**, and **Reset to code** goes back to the manifest.

A business's description, `guidance`, own schedules, intents, skills, servers and budget stay in
code; its how-we-work note is edited on the Brain page.

What runs:

- Each business (its `roles`, `policies` and `defaultPolicy`) and the assistant (everything but its
  id and home business) is saved as one document in `org_overrides`, with every save and reset in
  `org_override_versions` (migration `0015_org_overrides`).
- A save is checked as a whole first, with the same checks as the manifests plus "every skill is in
  the bank", and refused with the list of problems. A save over a stale version gets a 409.
- An accepted save applies at once: the next task, handoff and chat prefix use it, and schedules
  are restarted. Running tasks keep the prompt they started with.
- If a code change makes a saved change invalid, the server logs it at boot and runs the code's
  version of that business. The page shows the problem until the change is saved again or reset.
- A save also records the code's version of the business at the time (`codeBase` in the
  document), so later code changes still reach the saved roles (`mergeOrgEdit`,
  `packages/verticals/src/org-merge.ts`): skills, actions, MCP servers, schedules (by id) and
  policies (by action type) the code added since the save join them, while what was removed in the
  app stays removed. A role's `tools`, `repo` and `maxTurns` always come from the code. A save from
  before `codeBase` existed takes everything the code has that it lacks.
- **Retired roles:** the old org chart's roles are listed in `RETIRED_ROLES` (`org-merge.ts`). A
  saved edit that still has one drops it (their text lives on in the how-we-work notes), and every
  role kept reports to the assistant. Specialists Dave added stand.

The API is `GET /api/org/config`, `PUT /api/org/config/:unit` (`{ data, expectedVersion }`),
`DELETE /api/org/config/:unit?expectedVersion=` (reset), `GET /api/org/config/:unit/history`,
`GET /api/org/config/:unit/versions/:version` and `POST /api/org/config/:unit/restore`. `:unit` is
a business id or `chief-of-staff`. Code: `apps/server/src/org-config.ts`,
`apps/web/src/pages/Org.tsx`, `apps/web/src/pages/OrgEdit.tsx`.

## Adding a specialist in code

Add a specialist only for work the assistant can't do with its own tools: a shell, a code
checkout, a heavy production pipeline. Everything else belongs in the business's how-we-work note
or a skill.

1. Edit the business's manifest in `packages/verticals/src/`. Add an entry to `roles`:

   ```ts
   {
     id: "podcast-producer",          // unique in the business, lower-case-with-dashes
     title: "Podcast Producer",
     reportsTo: "chief-of-staff",     // always the assistant
     aliases: ["podcast"],            // extra chat names: "podcast: …"
     mission: "Two or three sentences on what it does and what good looks like.",
     skills: ["brain-notes", "podcast-episode"],
     mcpServers: ["brain", "odoo"],   // optional subset of the business's
     tools: [],                       // optional Claude Code tools (Bash, Edit, ...)
     actions: ["brain.write"],        // what it usually proposes (display and prompt only)
     schedules: [],                   // optional; ids unique across the business
     kpis: ["One episode a month"],
     autonomyNotes: "Drafts everything; publishing always needs Dave.",
   }
   ```

   The assistant's charter lists every specialist with the first sentence of its mission, so say
   what it is for first.
2. A new skill goes in `skills/<name>/SKILL.md` (the tests check every role's skills exist).
3. Run `pnpm test`. The manifest is checked when it loads (`orgIssues`):
   - role ids and aliases are unique, and none is named like the assistant (`chief-of-staff`);
   - role MCP servers belong to the business;
   - schedule ids are unique across the business.

A business with no `roles` has no specialists: all its work is the assistant's. Removing or
renaming a specialist is safe: its old tasks keep the id and count as the assistant's.
