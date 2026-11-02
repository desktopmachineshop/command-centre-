# Plan: run agent work on Anthropic's cloud (Managed Agents)

**Status:** not started. This plan is on hold until Dave decides to go this way.
Written 2026-11-02, when Managed Agents was in beta (`managed-agents-2026-04-01`). Check the API
against the live docs before building anything: names and shapes may have changed.

## Why

Today every agent run is Claude Code (headless) inside the server's own Railway container
(`packages/agent-runtime/src/claude-code.ts`). That means:

- The Software Lead's Bash runs **as the server's user, in the server's container**. It is not a
  sandbox: a shell there could read the server's environment (database URL, admin token,
  `GITHUB_TOKEN`). That's why the tools are only given to tasks Dave starts (docs/SETUP.md,
  "Command Centre: the Software Lead").
- The container has to be logged in to Claude. Until it is, the start-up log says
  `runner: echo`.
- Agent runs share the server's memory and CPU, and `AGENT_MAX_CONCURRENT_PER_VERTICAL` keeps
  them few.

With Managed Agents, Anthropic runs the agent loop, and each run gets its own throwaway container
in Anthropic's cloud for bash, file edits and code. The server only coordinates.

## Shape

| Stays on Railway | Moves to Anthropic |
| --- | --- |
| Ingest (email, Odoo, webhooks, chat), triage, tasks and inbox, approvals and executors (email, Odoo, `github.pr.*`), notifications, brain, schedules and digests | The agent run: a Managed Agents **session** per task run, in its own cloud sandbox |
| Agents still only *propose* outward actions through the command-centre MCP; policies and approvals are unchanged | Each org role becomes a persisted, versioned **agent** (model, system prompt, skills, tools) |

### Pieces to build

1. **`ManagedAgentsRunner`** in `packages/agent-runtime`, implementing the existing
   `AgentRunner` interface (`runner.ts`), so the pipeline doesn't change.
   - Add a `"managed"` option to `AGENT_RUNNER` in `apps/server/src/config.ts` and keep
     `claude-code` as the fallback.
   - Map `AgentRunRequest`, then stream the session's events back as `AgentMessage`s, so the
     task page's live transcript works as before.
   - `resumeSessionId` becomes the Managed Agents session id, so replies continue the same
     session (VoiceConversations, task replies).
   - Reconnect safely: on every (re)connect, open the event stream, list past events, and
     dedupe by event id. The stream has no replay, and a dropped stream with a pending tool
     call deadlocks the session.
2. **Agent definitions, one per role.**
   - Generate them from `packages/verticals` (role mission, charter, skills from `skills/`).
   - Sync them from version-controlled files with `ant apply`, not `agents.create()` per run.
   - Store each agent's id. Sessions pin a version, so prompt changes don't break running work.
3. **Tools.**
   - Expose the command-centre MCP server (brain, actions, Odoo read tools, handoff) at a public
     HTTPS URL (`PUBLIC_BASE_URL`, `/mcp`), declared in the agent's `mcp_servers`.
   - **Auth:** MCP credentials live in a Managed Agents vault and attach per session. Today
     each run gets its own short-lived run token (`runTokens.issue`, scoped to task, run,
     vertical and role). Options:
     - (a) create a per-session vault credential carrying that run token, and remove it when
       the run ends;
     - (b) keep the token host-side and proxy MCP calls as custom tools.

     Pick after checking current vault limits.
   - Coding roles (`role.tools`) get the agent toolset (bash, files) inside the sandbox. The
     repo is attached as a session resource and checked out in the container, which replaces
     `prepareCheckout` (`apps/server/src/code.ts`) for cloud runs.
4. **Software Lead first.**
   - It gains the most: real isolation, and no secrets anywhere near its shell.
   - `github.pr.create` / `github.pr.merge` stay server-side executors with `GITHUB_TOKEN`.
   - The agent pushes its branch only through `github.pr.create`. That needs the branch's
     commits, so either:
     - the sandbox pushes with a narrowly scoped vault `environment_variable` credential
       (substituted at egress, never visible in the sandbox), or
     - the agent hands back a patch or bundle for the server to push.

     Decide when building.
   - Keep the rule that only tasks Dave started get coding tools.
5. **Budgets.**
   - Set a hard dollar cap on each session (session `budget`) from the vertical's remaining
     daily budget (`BudgetService`).
   - Record `costUsd` from the session's usage, as now.
6. **Then every other role.** Move them once the Software Lead runs well. Keep
   `AGENT_RUNNER=claude-code` as the fallback, switchable per role if needed.

## Prerequisites

- An Anthropic API key (console.anthropic.com → API keys) set as `ANTHROPIC_API_KEY` in Railway.
  It's billed per token through the API, plus sandbox runtime. Compare that with the current
  runner's billing before switching.
- `PUBLIC_BASE_URL` set to the Railway HTTPS address, so cloud agents can reach `/mcp`.

## Risks and open questions

- **Beta:** the API may change, so pin the beta header and keep the local runner.
- **Latency:** each task run starts a sandbox, which matters for chat and Drive mode. Maybe keep
  chat/voice on the local runner and send long or coding work to the cloud.
- **Data:** emails and Odoo content go to Anthropic as now, but sandboxes also hold repo checkouts
  and files. Check the account's retention settings.
- **Run-token auth (3) and branch push (4):** choose after reading the current vault docs.

## Done when

- `AGENT_RUNNER=managed` runs a Software Lead task end to end: cloud checkout, edits and tests,
  then `github.pr.create`, and its transcript and cost show on the task page.
- Every role can run on either runner, chosen by config.
- The "not a sandbox" warning in docs/SETUP.md is replaced for cloud runs.
