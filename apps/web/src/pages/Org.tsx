import type { OrgConfig, OrgRoleNode, OrgVerticalNode, RoleStats } from "@cc/core";
import { createContext, type CSSProperties, useContext, useEffect, useState } from "react";
import type { Api } from "../api";
import { ago, usd } from "../format";
import { Icon } from "../icons";
import { type LiveFeed, useLive, useLoad } from "../live";
import { ErrorBanner, PageHead, Skeleton, VTag } from "../ui";
import { OrgEditDialog, type OrgEditTarget, ROOT } from "./OrgEdit";

/** Set while editing: the saved config, and how to open an editor. */
const EditContext = createContext<{ config: OrgConfig; open: (t: OrgEditTarget) => void } | null>(null);

/** Wide screens start with every branch open; phones start collapsed. */
const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 641px)").matches;

const inboxLink = (vertical: string, role: string) => `#/inbox?${new URLSearchParams({ vertical, role })}`;

/**
 * Businesses: the assistant (which takes every task), then each business with what it is, how it
 * works (its how-we-work note in the brain), its approval policies, schedules, budget and
 * specialists, with live numbers. Edit opens the same editors as before: policies, specialists, history.
 */
export function Org({ api, feed }: { api: Api; feed: LiveFeed }) {
  const { data, error, reload } = useLoad(api.org, feed, (m) => m.type === "task.updated" || m.type === "proposal.updated" || m.type === "org.updated");
  const open = wide();
  const [editing, setEditing] = useState(false);
  const [config, setConfig] = useState<OrgConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [target, setTarget] = useState<OrgEditTarget | null>(null);

  const loadConfig = () => api.orgConfig().then(setConfig, (e: Error) => setConfigError(e.message));
  useEffect(() => {
    if (editing) void loadConfig();
  }, [editing]);
  // Someone else saved: refresh the editor's versions (an open dialog keeps its draft and gets a 409 if stale).
  useLive(feed, (m) => {
    if (m.type === "org.updated" && editing) void loadConfig();
  });
  const saved = (c: OrgConfig) => {
    setConfig(c);
    void reload();
  };
  const edit = editing && config ? { config, open: setTarget } : null;

  return (
    <section className="org">
      <PageHead
        title="Businesses"
        sub={
          editing
            ? "Editing: changes apply to the next task. Each business keeps a history you can restore or reset to the code."
            : `Your assistant takes every task and works across these businesses, handing specialist work to the specialists. Live numbers over the last ${data?.windowDays ?? 7} days.`
        }
      >
        <button type="button" className={editing ? "primary" : ""} aria-pressed={editing} onClick={() => setEditing(!editing)}>
          <Icon name={editing ? "check" : "edit"} /> {editing ? "Done" : "Edit"}
        </button>
      </PageHead>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {editing && configError && <ErrorBanner>{configError}</ErrorBanner>}
      {!data && !error && <Skeleton rows={2} />}
      {data && (
        <EditContext.Provider value={edit}>
          <RoleCard node={data.root} root />
          <UnitTools unit={ROOT} />
          <ol className="org-verticals">
            {data.root.verticals.map((v) => (
              <VerticalBranch key={v.id} vertical={v} open={open} />
            ))}
          </ol>
        </EditContext.Provider>
      )}
      {edit && target && <OrgEditDialog api={api} config={edit.config} target={target} onSaved={saved} close={() => setTarget(null)} />}
    </section>
  );
}

/** Add specialist, policies and history for a business (or history for the assistant), plus a saved change that isn't running. */
function UnitTools({ unit }: { unit: string }) {
  const edit = useContext(EditContext);
  if (!edit) return null;
  const info = unit === ROOT ? edit.config.root : edit.config.verticals.find((v) => v.unit === unit);
  if (!info) return null;
  return (
    <div className="org-tools" data-help-pane="org.edit">
      {info.problem && (
        <ErrorBanner>
          The change saved for this no longer fits the code, so the code's version runs: {info.problem}. Fix it by saving again, or reset it from History.
        </ErrorBanner>
      )}
      <div className="row wrap small">
        {unit !== ROOT && (
          <>
            <button type="button" className="ghost" onClick={() => edit.open({ type: "role", unit, roleId: null })}>
              <Icon name="plus" /> Add specialist
            </button>
            <button type="button" className="ghost" onClick={() => edit.open({ type: "policies", unit })}>
              <Icon name="sliders" /> Policies
            </button>
          </>
        )}
        <button type="button" className="ghost" onClick={() => edit.open({ type: "history", unit })}>
          <Icon name="clock" /> History
        </button>
        <span className="muted">{info.overridden ? `Changed in the app${info.updatedAt ? ` ${ago(info.updatedAt)}` : ""}` : "As in the code"}</span>
      </div>
    </div>
  );
}

const POLICY_LABEL: Record<string, string> = { auto: "runs straight away", "auto-with-digest": "runs, listed in the digest", draft: "waits for you" };

function VerticalBranch({ vertical, open }: { vertical: OrgVerticalNode; open: boolean }) {
  const style = vertical.color ? ({ "--vertical": vertical.color } as CSSProperties) : undefined;
  const policies = Object.entries(vertical.policies).sort(([a], [b]) => a.localeCompare(b));
  return (
    <li className="org-vertical" style={style}>
      <details open={open}>
        <summary>
          <strong>{vertical.name}</strong> <Stats stats={vertical.stats} />
        </summary>
        <UnitTools unit={vertical.id} />
        <div className="card org-business">
          <p className="small">{vertical.description}</p>
          <p className="small">
            <a href={`#/brain/${encodeURIComponent(`${vertical.brainFolder}/how-we-work.md`)}`}>How {vertical.name} works</a>
            <span className="muted"> · notes in the brain under {vertical.brainFolder}/</span>
          </p>
          <div className="row small wrap">
            <span className="muted">Budget</span>
            <span className="tag">{vertical.dailyBudgetUsd ? `${usd(vertical.dailyBudgetUsd)} a day` : "no daily cap"}</span>
          </div>
          <Chips label="Schedules" items={vertical.schedules.map((s) => `${s.id} (${s.cron}${s.enabled ? "" : ", off"})`)} />
          <details>
            <summary className="small muted">Approval policies: anything not listed {POLICY_LABEL[vertical.defaultPolicy] ?? vertical.defaultPolicy}</summary>
            <ul className="small org-policies">
              {policies.map(([type, policy]) => (
                <li key={type}>
                  <code>{type}</code> {POLICY_LABEL[policy] ?? policy}
                </li>
              ))}
            </ul>
          </details>
        </div>
        {vertical.specialists.length > 0 && (
          <ol className="org-branch">
            {vertical.specialists.map((r) => (
              <li key={r.id}>
                <RoleCard node={r} />
              </li>
            ))}
          </ol>
        )}
      </details>
    </li>
  );
}

function RoleCard({ node, root = false }: { node: OrgRoleNode; root?: boolean }) {
  const edit = useContext(EditContext);
  return (
    <article className="card org-card" aria-label={node.title}>
      <header className="row between">
        <a className="title" href={inboxLink(node.vertical, node.id)} title={root ? "Show the assistant's tasks" : "Show this specialist's tasks"}>
          {node.title}
        </a>
        <span className="row">
          {root ? <span className="tag">every business</span> : <><span className="tag">specialist</span> <VTag id={node.vertical} /></>}
          {edit && (
            <button
              type="button"
              className="ghost icon-btn"
              aria-label={`Edit ${node.title}`}
              title="Edit"
              onClick={() => edit.open({ type: "role", unit: root ? ROOT : node.vertical, roleId: root ? ROOT : node.id })}
            >
              <Icon name="edit" />
            </button>
          )}
        </span>
      </header>
      <Stats stats={node.stats} />
      <details>
        <summary className="small muted">Mission and tools</summary>
        <p className="small">{node.mission}</p>
        {node.autonomyNotes && (
          <p className="small">
            <strong>Autonomy:</strong> {node.autonomyNotes}
          </p>
        )}
        <Chips label="Skills" items={node.skills} />
        {!root && <Chips label="Tools" items={[...node.mcpServers.map((s) => `mcp:${s}`), ...node.actions]} />}
        <Chips label="Schedules" items={node.schedules.map((s) => `${s.id} (${s.cron}${s.enabled ? "" : ", off"})`)} />
        {!root && <Chips label="Address as" items={[node.id, ...node.aliases].map((a) => `${a}:`)} />}
        {node.kpis.length > 0 && (
          <ul className="small org-kpis">
            {node.kpis.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        )}
      </details>
    </article>
  );
}

function Stats({ stats }: { stats: RoleStats }) {
  return (
    <span className="row small wrap muted org-stats">
      <span>{stats.openTasks} open</span>
      <span>{stats.doneTasks} done</span>
      <span>{usd(stats.costUsd)}</span>
      <span className={stats.pendingApprovals ? "status awaiting_approval" : ""}>{stats.pendingApprovals} to approve</span>
    </span>
  );
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="row small wrap">
      <span className="muted">{label}</span>
      {items.map((i) => (
        <span key={i} className="tag">
          {i}
        </span>
      ))}
    </div>
  );
}
