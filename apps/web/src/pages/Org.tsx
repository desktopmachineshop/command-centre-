import type { OrgRoleNode, OrgVerticalNode, RoleStats } from "@cc/core";
import type { CSSProperties } from "react";
import type { Api } from "../api";
import { usd } from "../format";
import { type LiveFeed, useLoad } from "../live";
import { ErrorBanner, PageHead, Skeleton, VTag } from "../ui";

/** Wide screens start with every branch open; phones start collapsed. */
const wide = () => typeof matchMedia === "function" && matchMedia("(min-width: 641px)").matches;

const inboxLink = (vertical: string, role: string) => `#/inbox?${new URLSearchParams({ vertical, role })}`;

/** The org chart: Chief of Staff → verticals → leads → roles, with live numbers per role. */
export function Org({ api, feed }: { api: Api; feed: LiveFeed }) {
  const { data, error } = useLoad(api.org, feed, (m) => m.type === "task.updated" || m.type === "proposal.updated");
  const open = wide();

  return (
    <section className="org">
      <PageHead title="Org" sub={`Live numbers over the last ${data?.windowDays ?? 7} days. Choose a role to see its tasks in the Inbox.`} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!data && !error && <Skeleton rows={2} />}
      {data && (
        <ol className="org-tree">
          <li>
            <RoleCard node={data.root} />
            <ol className="org-verticals">
              {data.root.verticals.map((v) => (
                <VerticalBranch key={v.id} vertical={v} open={open} />
              ))}
            </ol>
          </li>
        </ol>
      )}
    </section>
  );
}

function VerticalBranch({ vertical, open }: { vertical: OrgVerticalNode; open: boolean }) {
  const style = vertical.color ? ({ "--vertical": vertical.color } as CSSProperties) : undefined;
  return (
    <li className="org-vertical" style={style}>
      <details open={open}>
        <summary>
          <strong>{vertical.name}</strong> <Stats stats={vertical.stats} />
        </summary>
        <ol className="org-branch">
          <RoleBranch node={vertical.lead} />
        </ol>
      </details>
    </li>
  );
}

function RoleBranch({ node }: { node: OrgRoleNode }) {
  return (
    <li>
      <RoleCard node={node} />
      {node.children.length > 0 && (
        <ol className="org-branch">
          {node.children.map((c) => (
            <RoleBranch key={c.id} node={c} />
          ))}
        </ol>
      )}
    </li>
  );
}

function RoleCard({ node }: { node: OrgRoleNode }) {
  return (
    <article className="card org-card" aria-label={node.title}>
      <header className="row between">
        <a className="title" href={inboxLink(node.vertical, node.id)} title="Show this role's tasks">
          {node.title}
        </a>
        {node.reportsTo === null ? <span className="tag">all verticals</span> : <VTag id={node.vertical} />}
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
        <Chips label="Intents" items={node.intents} />
        <Chips label="Skills" items={node.skills} />
        <Chips label="Tools" items={[...node.mcpServers.map((s) => `mcp:${s}`), ...node.actions]} />
        <Chips label="Schedules" items={node.schedules.map((s) => `${s.id} (${s.cron}${s.enabled ? "" : ", off"})`)} />
        <Chips label="Address as" items={[node.id, ...node.aliases].map((a) => `${a}:`)} />
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
