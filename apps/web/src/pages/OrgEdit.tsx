/**
 * Editing the org from the Org page: a role (or the Chief of Staff), a vertical's
 * action policies, and each unit's history. Every save sends the whole unit (all of
 * a vertical's roles and its policies) with the version it started from; the server
 * checks the whole org first and answers 400 with the problems, or 409 when someone
 * saved in between. See docs/ORG.md.
 */
import type { OrgConfig, OrgConfigVersion, Policy, Role, RootOrgEdit, Schedule, VerticalOrgEdit } from "@cc/core";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { type Api, ApiError } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { Dialog, ErrorBanner } from "../ui";

export const ROOT = "chief-of-staff";

export type OrgEditTarget =
  | { type: "role"; unit: string; roleId: string | null }
  | { type: "policies"; unit: string }
  | { type: "history"; unit: string };

type VerticalUnit = OrgConfig["verticals"][number];

const POLICIES: { value: Policy; label: string }[] = [
  { value: "draft", label: "Waits for approval" },
  { value: "auto-with-digest", label: "Runs, listed in the digest" },
  { value: "auto", label: "Runs straight away" },
];

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
const uniq = (xs: string[]) => [...new Set(xs)];

/** Saves one unit and hands the new config back; turns the server's refusals into readable text. */
function useSave(api: Api, onSaved: (c: OrgConfig) => void) {
  const [error, setError] = useState<ReactNode>(null);
  const [saving, setSaving] = useState(false);
  const run = async (call: () => Promise<OrgConfig>) => {
    setSaving(true);
    setError(null);
    try {
      onSaved(await call());
      return true;
    } catch (err) {
      const issues = err instanceof ApiError ? (err.body?.issues as unknown) : undefined;
      if (Array.isArray(issues) && issues.every((i) => typeof i === "string")) {
        setError(
          <>
            This change would break the org:
            <ul>
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </>,
        );
      } else if (err instanceof ApiError && err.status === 409) {
        setError("Someone else changed this part of the org since you opened it. Close this, and your edit can be made again on the latest version.");
      } else setError((err as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  return { error, saving, run };
}

export function OrgEditDialog({ api, config, target, onSaved, close }: { api: Api; config: OrgConfig; target: OrgEditTarget; onSaved: (c: OrgConfig) => void; close: () => void }) {
  if (target.type === "history") return <HistoryDialog api={api} config={config} unit={target.unit} onSaved={onSaved} close={close} />;
  const vertical = config.verticals.find((v) => v.unit === target.unit);
  if (target.type === "policies") return vertical ? <PoliciesDialog api={api} config={config} unit={vertical} onSaved={onSaved} close={close} /> : null;
  return <RoleDialog api={api} config={config} unit={target.unit} roleId={target.roleId} onSaved={onSaved} close={close} />;
}

type Draft = {
  id: string;
  title: string;
  reportsTo: string;
  mission: string;
  autonomyNotes: string;
  aliases: string;
  intents: string[];
  skills: string[];
  /** null: all of the vertical's servers. */
  mcpServers: string[] | null;
  actions: string[];
  kpis: string;
  schedules: Schedule[];
  /** Kept as they are (not edited here): a coding role's own tools and repository. */
  tools: Role["tools"];
  repo?: string;
};

const toDraft = (r: Omit<Role, "reportsTo"> & { reportsTo?: string }): Draft => ({
  id: r.id,
  title: r.title,
  reportsTo: r.reportsTo ?? ROOT,
  mission: r.mission,
  autonomyNotes: r.autonomyNotes,
  aliases: r.aliases.join(", "),
  intents: r.intents,
  skills: r.skills,
  mcpServers: r.mcpServers ?? null,
  actions: r.actions,
  kpis: r.kpis.join("\n"),
  schedules: r.schedules,
  tools: r.tools ?? [],
  repo: r.repo,
});

const fromDraft = (d: Draft): Role => ({
  id: d.id,
  title: d.title.trim(),
  reportsTo: d.reportsTo,
  mission: d.mission.trim(),
  autonomyNotes: d.autonomyNotes.trim(),
  aliases: list(d.aliases).map(slug).filter(Boolean),
  intents: d.intents,
  skills: d.skills,
  ...(d.mcpServers ? { mcpServers: d.mcpServers } : {}),
  actions: d.actions,
  kpis: lines(d.kpis),
  schedules: d.schedules,
  tools: d.tools,
  ...(d.repo ? { repo: d.repo } : {}),
});

/**
 * The new roles of a vertical once `role` is saved: it replaces its old self (or is added),
 * intents it took are taken off their old owner, and making it the lead puts the old lead under it.
 */
function nextRoles(roles: Role[], role: Role, isNew: boolean): Role[] {
  const oldLead = roles.find((r) => r.reportsTo === ROOT);
  let out = roles.map((r) => (r.id === role.id ? role : { ...r, intents: r.intents.filter((i) => !role.intents.includes(i)) }));
  if (isNew) out = [...out, role];
  if (role.reportsTo === ROOT && oldLead && oldLead.id !== role.id) out = out.map((r) => (r.id === oldLead.id ? { ...r, reportsTo: role.id } : r));
  return out;
}

function RoleDialog({ api, config, unit, roleId, onSaved, close }: { api: Api; config: OrgConfig; unit: string; roleId: string | null; onSaved: (c: OrgConfig) => void; close: () => void }) {
  const isRoot = unit === ROOT;
  const vertical = config.verticals.find((v) => v.unit === unit);
  const roles = vertical?.current.roles ?? [];
  const existing = isRoot ? { ...config.root.current, id: ROOT } : roles.find((r) => r.id === roleId);
  const isNew = !existing;
  const lead = roles.find((r) => r.reportsTo === ROOT);
  const [draft, setDraft] = useState<Draft>(() =>
    existing
      ? toDraft(existing)
      : toDraft({ id: "", title: "", reportsTo: lead?.id ?? ROOT, mission: "", autonomyNotes: "", aliases: [], intents: [], skills: ["brain-notes"], actions: [], kpis: [], schedules: [], tools: [] }),
  );
  const { error, saving, run } = useSave(api, onSaved);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const servers = isRoot ? config.root.mcpServers : (vertical?.mcpServers ?? []);
  const reports = roles.filter((r) => r.reportsTo === roleId);
  const isLead = !isRoot && !!existing && "reportsTo" in existing && existing.reportsTo === ROOT;
  const id = isNew ? draft.id || slug(draft.title) : draft.id;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const role = fromDraft({ ...draft, id });
    if (isRoot) {
      const { id: _id, reportsTo: _r, ...rest } = role;
      if (await run(() => api.orgSave(ROOT, rest satisfies RootOrgEdit, config.root.version))) close();
    } else if (vertical) {
      const data: VerticalOrgEdit = { ...vertical.current, roles: nextRoles(roles, role, isNew) };
      if (await run(() => api.orgSave(unit, data, vertical.version))) close();
    }
  };

  const remove = async () => {
    if (!vertical || !existing || !confirm(`Remove ${existing.title}? Its tasks stay and count as the lead's. The change can be undone from History.`)) return;
    if (await run(() => api.orgSave(unit, { ...vertical.current, roles: roles.filter((r) => r.id !== existing.id) }, vertical.version))) close();
  };

  const ownerOf = (intent: string) => roles.find((r) => r.id !== id && r.intents.includes(intent));
  const skillNames = uniq([...config.skills.map((s) => s.name), ...draft.skills]);
  const actionTypes = uniq([...config.actionTypes, ...draft.actions]).sort();

  return (
    <Dialog
      title={isNew ? `New role in ${vertical?.name ?? unit}` : `Edit ${existing.title}`}
      onClose={close}
      footer={
        <>
          {!isNew && !isRoot && !isLead && (
            <button type="button" className="danger" onClick={remove} disabled={saving || reports.length > 0} title={reports.length ? "Move the roles reporting to it first" : undefined}>
              <Icon name="trash" /> Remove
            </button>
          )}
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="org-role-form" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="org-role-form" className="org-edit" onSubmit={save}>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <label className="field">
          <span>Title</span>
          <input value={draft.title} onChange={(e) => set({ title: e.target.value })} required placeholder="Wholesale" />
        </label>
        {isNew && (
          <label className="field">
            <span>Id</span>
            <input value={id} onChange={(e) => set({ id: slug(e.target.value) })} required pattern="[a-z0-9-]+" aria-describedby="org-id-hint" />
            <span id="org-id-hint" className="muted small">
              Lower-case with dashes. It can't be changed later: tasks keep it.
            </span>
          </label>
        )}
        {!isRoot && (
          <label className="field">
            <span>Reports to</span>
            {isLead ? (
              <>
                <input value="Chief of Staff (this is the lead)" readOnly />
                <span className="muted small">To change the lead, edit another role and make it report to the Chief of Staff.</span>
              </>
            ) : (
              <>
                <select value={draft.reportsTo} onChange={(e) => set({ reportsTo: e.target.value })}>
                  {roles
                    .filter((r) => r.id !== id)
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                  <option value={ROOT}>Chief of Staff (make this the lead)</option>
                </select>
                {draft.reportsTo === ROOT && lead && <span className="muted small">{lead.title} will report to this role instead.</span>}
              </>
            )}
          </label>
        )}
        <label className="field">
          <span>Mission</span>
          <textarea value={draft.mission} onChange={(e) => set({ mission: e.target.value })} rows={4} required placeholder="Two or three sentences: what it does and what good looks like." />
        </label>
        <label className="field">
          <span>Autonomy</span>
          <textarea value={draft.autonomyNotes} onChange={(e) => set({ autonomyNotes: e.target.value })} rows={3} placeholder="What it may do on its own, and what always needs Dave." />
          <span className="muted small">Guidance for the agent. Whether an action runs or waits is set by the vertical's policies.</span>
        </label>
        {!isRoot && vertical && (
          <Picker
            label="Owns these kinds of work"
            hint="Triage intents. Picking one another role owns moves it here; unowned ones go to the lead."
            options={vertical.intents}
            value={draft.intents}
            onChange={(intents) => set({ intents })}
            note={(i) => {
              const o = ownerOf(i);
              return o && !draft.intents.includes(i) ? o.title : undefined;
            }}
          />
        )}
        <Picker label="Skills" hint="Only these are in its workspace." options={skillNames} value={draft.skills} onChange={(skills) => set({ skills })} />
        <fieldset className="field">
          <legend>Tools</legend>
          <label className="row small">
            <input type="checkbox" checked={draft.mcpServers === null} onChange={(e) => set({ mcpServers: e.target.checked ? null : servers })} /> All of{" "}
            {isRoot ? "its home vertical's" : "the vertical's"} servers
          </label>
          {draft.mcpServers && <Picker options={servers} value={draft.mcpServers} onChange={(mcpServers) => set({ mcpServers })} />}
        </fieldset>
        <Picker label="Usually proposes" hint="Shown to the agent and on the chart." options={actionTypes} value={draft.actions} onChange={(actions) => set({ actions })} />
        <label className="field">
          <span>Also answers to</span>
          <input value={draft.aliases} onChange={(e) => set({ aliases: e.target.value })} placeholder="trade, wholesale" />
          <span className="muted small">Comma-separated chat names, as in "trade: …".</span>
        </label>
        <label className="field">
          <span>Measured on</span>
          <textarea value={draft.kpis} onChange={(e) => set({ kpis: e.target.value })} rows={3} placeholder="One per line" />
        </label>
        <Schedules value={draft.schedules} onChange={(schedules) => set({ schedules })} />
      </form>
    </Dialog>
  );
}

/** Toggle chips over a fixed set of options. */
function Picker({ label, hint, options, value, onChange, note }: { label?: string; hint?: string; options: string[]; value: string[]; onChange: (v: string[]) => void; note?: (o: string) => string | undefined }) {
  const chips = (
    <div className="chips">
      {options.map((o) => {
        const on = value.includes(o);
        const n = note?.(o);
        return (
          <label key={o} className={`chip${on ? " on" : ""}`}>
            <input type="checkbox" checked={on} onChange={() => onChange(on ? value.filter((v) => v !== o) : [...value, o])} />
            {o}
            {n && <span className="muted">· {n}</span>}
          </label>
        );
      })}
      {!options.length && <span className="muted small">None available.</span>}
    </div>
  );
  if (!label) return chips;
  return (
    <fieldset className="field">
      <legend>{label}</legend>
      {hint && <span className="muted small">{hint}</span>}
      {chips}
    </fieldset>
  );
}

function Schedules({ value, onChange }: { value: Schedule[]; onChange: (v: Schedule[]) => void }) {
  const update = (i: number, patch: Partial<Schedule>) => onChange(value.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <fieldset className="field">
      <legend>Schedules</legend>
      <span className="muted small">Each fires a task for this role. Cron times are in the schedule's timezone.</span>
      {value.map((s, i) => (
        <div key={i} className="card org-schedule">
          <div className="row wrap">
            <label className="field grow">
              <span>Id</span>
              <input value={s.id} onChange={(e) => update(i, { id: slug(e.target.value) })} required pattern="[a-z0-9-]+" />
            </label>
            <label className="field grow">
              <span>Cron</span>
              <input value={s.cron} onChange={(e) => update(i, { cron: e.target.value })} required placeholder="0 7 * * 1-5" />
            </label>
            <label className="field grow">
              <span>Timezone</span>
              <input value={s.timezone} onChange={(e) => update(i, { timezone: e.target.value })} required />
            </label>
          </div>
          <label className="field">
            <span>Prompt</span>
            <textarea value={s.prompt} onChange={(e) => update(i, { prompt: e.target.value })} rows={5} required />
          </label>
          <div className="row between">
            <label className="row small">
              <input type="checkbox" checked={s.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} /> On
            </label>
            <button type="button" className="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Icon name="trash" /> Remove schedule
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => onChange([...value, { id: "", cron: "0 9 * * 1-5", timezone: "Europe/London", prompt: "", enabled: false }])}>
        <Icon name="plus" /> Add schedule
      </button>
    </fieldset>
  );
}

function PoliciesDialog({ api, config, unit, onSaved, close }: { api: Api; config: OrgConfig; unit: VerticalUnit; onSaved: (c: OrgConfig) => void; close: () => void }) {
  const [policies, setPolicies] = useState(unit.current.policies);
  const [defaultPolicy, setDefaultPolicy] = useState(unit.current.defaultPolicy);
  const { error, saving, run } = useSave(api, onSaved);
  const types = uniq([...config.actionTypes, ...Object.keys(policies), ...unit.current.roles.flatMap((r) => r.actions)]).sort();
  const label = (p: Policy) => POLICIES.find((x) => x.value === p)!.label;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(() => api.orgSave(unit.unit, { ...unit.current, policies, defaultPolicy }, unit.version))) close();
  };

  return (
    <Dialog
      title={`${unit.name}: what runs without asking`}
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="org-policy-form" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="org-policy-form" className="org-edit" onSubmit={save}>
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <p className="muted small">Work that started with an email, webhook or other outside message always waits for approval, whatever is set here.</p>
        <label className="field">
          <span>Anything not listed</span>
          <select value={defaultPolicy} onChange={(e) => setDefaultPolicy(e.target.value as Policy)}>
            {POLICIES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <div className="org-policies">
          {types.map((t) => (
            <label key={t} className="row between">
              <code>{t}</code>
              <select
                value={policies[t] ?? ""}
                onChange={(e) => {
                  const { [t]: _, ...rest } = policies;
                  setPolicies(e.target.value ? { ...rest, [t]: e.target.value as Policy } : rest);
                }}
              >
                <option value="">Default ({label(defaultPolicy).toLowerCase()})</option>
                {POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

function HistoryDialog({ api, config, unit, onSaved, close }: { api: Api; config: OrgConfig; unit: string; onSaved: (c: OrgConfig) => void; close: () => void }) {
  const [versions, setVersions] = useState<OrgConfigVersion[] | null>(null);
  const { error, saving, run } = useSave(api, onSaved);
  const info = unit === ROOT ? config.root : config.verticals.find((v) => v.unit === unit)!;
  const name = unit === ROOT ? "Chief of Staff" : (info as VerticalUnit).name;
  const load = () => api.orgHistory(unit).then(setVersions, () => setVersions([]));
  useEffect(() => void load(), [unit, info.version]);

  const reset = async () => {
    if (confirm(`Put ${name} back to how the code defines it? Your changes stay in this history and can be restored.`)) await run(() => api.orgReset(unit, info.version));
  };

  return (
    <Dialog
      title={`${name}: history`}
      onClose={close}
      footer={
        <>
          {info.overridden && (
            <button type="button" onClick={reset} disabled={saving}>
              <Icon name="refresh" /> Reset to code
            </button>
          )}
          <button type="button" onClick={close}>
            Close
          </button>
        </>
      }
    >
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <p className="muted small">
        {info.overridden ? `Running a change saved from the app${info.updatedBy ? ` by ${info.updatedBy}` : ""}${info.updatedAt ? `, ${ago(info.updatedAt)}` : ""}.` : "Running as the code defines it."}
      </p>
      {versions === null ? (
        <p className="muted small">Loading…</p>
      ) : versions.length === 0 ? (
        <p className="muted small">No changes yet.</p>
      ) : (
        <ol className="org-history">
          {versions.map((v) => (
            <li key={v.version} className="row between">
              <span>
                <strong>v{v.version}</strong> {v.reset ? "reset to code" : "saved"} by {v.author} <span className="muted small">{ago(v.createdAt)}</span>
              </span>
              {v.version !== info.version && !v.reset && (
                <button type="button" className="ghost" disabled={saving} onClick={() => run(() => api.orgRestore(unit, v.version))}>
                  Restore
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}
