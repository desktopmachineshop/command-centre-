import { type FormEvent, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { type Api, ApiError } from "../api";
import { ago } from "../format";
import { Icon, type IconName } from "../icons";
import {
  APP_PROVIDERS,
  chosenCalendars,
  DEFAULT_ID,
  describeResult,
  editableFields,
  type EntryView,
  entryStatus,
  entryTitle,
  type FieldDef,
  type FormValues,
  GMAIL_PRESET,
  GROUP_LABELS,
  type Group,
  initialValues,
  type IntegrationsView,
  isValidId,
  type KindDef,
  oauthReturn,
  redirectUri,
  type SaveResult,
  type Section,
  suggestId,
  toPatch,
  validate,
} from "../integrations";
import { type LiveFeed, useLoad } from "../live";
import { routeQuery, useRouteQuery } from "../router";
import { platformLabel } from "../social";
import { Dialog, Empty, ErrorBanner, PageHead, Skeleton, VerticalsContext, VTag } from "../ui";
import { CopyButton } from "../copy";

/**
 * Accounts: every platform Command Centre signs in to, managed here instead of in Railway's
 * variables. Renders straight from the server's catalogue (GET /api/integrations): each kind
 * has a card per entry with its status, a form built from its fields, Test, Connect (OAuth),
 * Move into app and Disconnect. Changes apply straight away; the server reloads what they affect.
 */

type Notice = { ok: boolean; text: string };

type DialogState =
  | { type: "edit"; def: KindDef; entry?: EntryView; id?: string; vertical?: string }
  | { type: "add"; kinds: KindDef[]; title: string; vertical?: string }
  | { type: "needsApp"; def: KindDef; app: KindDef }
  | { type: "remove"; def: KindDef; entry: EntryView }
  | { type: "calendars"; entry: EntryView }
  | { type: "claude" };

interface Ctx {
  api: Api;
  view: IntegrationsView;
  kinds: Map<string, KindDef>;
  busy: string | null;
  open: (d: DialogState) => void;
  /** Runs a change, shows its outcome, reloads. */
  run: (key: string, verb: string, fn: () => Promise<SaveResult>) => Promise<void>;
  connect: (def: KindDef, id: string, vertical?: string) => Promise<void>;
  notify: (n: Notice) => void;
  reload: () => void;
}

const SECTION_ICONS: Record<Section, IconName> = { ai: "spark", business: "briefcase", google: "globe", social: "social", settings: "sliders", apps: "code" };

const isUpdate = (m: { type: string }) => m.type === "integrations.updated";

export function Connections({ api, feed }: { api: Api; feed: LiveFeed }) {
  const load = useLoad(api.integrations, feed, (m) => isUpdate(m as { type: string }));
  const view = load.data;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [returned, setReturned] = useState<ReturnType<typeof oauthReturn>>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const query = useRouteQuery();

  // Back from a sign-in: #/accounts?connected=<kind>&id=<id> or ?oauthError=<message>.
  useEffect(() => {
    const r = oauthReturn(routeQuery());
    if (!r) return;
    setReturned(r);
    history.replaceState(null, "", `${location.pathname}${location.search}#/accounts`);
  }, [query]);
  const kinds = useMemo(() => new Map((view?.kinds ?? []).map((k) => [k.kind, k])), [view]);
  useEffect(() => {
    if (!returned || !view) return;
    if (returned.kind === "error") setNotice({ ok: false, text: `Sign-in didn't finish: ${returned.message}` });
    else {
      const def = kinds.get(returned.entryKind);
      const entry = view.entries.find((e) => e.kind === returned.entryKind && (!returned.id || e.id === returned.id));
      const who = entry?.meta.account ? ` as ${entry.meta.account}` : "";
      setNotice({ ok: true, text: `${def?.label ?? returned.entryKind} connected${who}.` });
      const anchor = cardId(returned.entryKind, returned.id ?? DEFAULT_ID);
      setHighlight(anchor);
      requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: "center", behavior: "smooth" }));
      setTimeout(() => setHighlight(null), 2600);
    }
    setReturned(null);
  }, [returned, view]);

  const ctx: Ctx | null = view
    ? {
        api,
        view,
        kinds,
        busy,
        open: setDialog,
        notify: setNotice,
        reload: () => void load.reload(),
        run: async (key, verb, fn) => {
          setBusy(key);
          try {
            setNotice(describeResult(await fn(), verb));
          } catch (e) {
            setNotice({ ok: false, text: (e as Error).message });
          } finally {
            setBusy(null);
            void load.reload();
          }
        },
        connect: async (def, id, vertical) => {
          const app = def.needsApp ? kinds.get(def.needsApp) : undefined;
          if (app && !view.entries.some((e) => e.kind === app.kind)) {
            setDialog({ type: "needsApp", def, app });
            return;
          }
          setBusy(`connect:${def.kind}:${id}`);
          try {
            const { url } = await api.startOAuth(def.oauth!, { id, ...(vertical ? { vertical } : {}) });
            location.href = url;
          } catch (e) {
            setBusy(null);
            setDialog(null);
            const msg = e instanceof ApiError && e.status === 404 ? `Signing in to ${def.label} isn't available on this server yet.` : (e as Error).message;
            setNotice({ ok: false, text: msg });
          }
        },
      }
    : null;

  return (
    <section className="accounts">
      <PageHead title="Accounts" sub="Sign in to everything Command Centre uses. Changes apply straight away." />
      {notice && (
        <div className={`acc-notice ${notice.ok ? "ok" : "bad"}`} role={notice.ok ? "status" : "alert"}>
          <Icon name={notice.ok ? "check" : "alert"} />
          <span className="grow">{notice.text}</span>
          <button type="button" className="ghost icon-btn small" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {load.error && !view && <ErrorBanner>{load.error}</ErrorBanner>}
      {!view && !load.error && <Skeleton rows={4} />}
      {ctx && (
        <div>
          <Sections ctx={ctx} highlight={highlight} appsOpen={appsOpen} setAppsOpen={setAppsOpen} />
          <RailwayOnly view={ctx.view} />
        </div>
      )}
      {ctx && dialog && <DialogFor ctx={ctx} dialog={dialog} close={() => setDialog(null)} openApps={() => setAppsOpen(true)} />}
    </section>
  );
}

const cardId = (kind: string, id: string) => `acc-${kind}-${id}`;

/** Group reload errors, each shown once by the first section whose kinds affect it. */
function groupErrors(view: IntegrationsView): Map<Section, [Group, string][]> {
  const seen = new Set<Group>();
  const out = new Map<Section, [Group, string][]>();
  const order: Section[] = ["ai", "business", "google", "social", "settings", "apps"];
  for (const s of order) {
    const list: [Group, string][] = [];
    for (const k of view.kinds.filter((k) => k.section === s))
      for (const g of k.affects) {
        const msg = view.groups[g];
        if (msg && !seen.has(g)) {
          seen.add(g);
          list.push([g, msg]);
        }
      }
    out.set(s, list);
  }
  return out;
}

function Sections({ ctx, highlight, appsOpen, setAppsOpen }: { ctx: Ctx; highlight: string | null; appsOpen: boolean; setAppsOpen: (o: boolean) => void }) {
  const { view } = ctx;
  const errs = groupErrors(view);
  const of = (s: Section) => view.kinds.filter((k) => k.section === s);
  const banners = (s: Section) =>
    errs.get(s)?.map(([g, m]) => (
      <ErrorBanner key={g}>
        <span>
          <strong>{GROUP_LABELS[g]}</strong> didn't restart with the new settings and is still using the old ones: {m}
        </span>
      </ErrorBanner>
    ));
  const apps = of("apps");
  const appsSet = apps.filter((a) => view.entries.some((e) => e.kind === a.kind)).length;
  return (
    <>
      <SectionHead section="ai" title="AI" />
      {banners("ai")}
      <div className="acc-grid">
        {of("ai").map((def) => (
          <SingleCard key={def.kind} ctx={ctx} def={def} highlight={highlight} />
        ))}
      </div>

      <SectionHead section="business" title="Business" />
      {banners("business")}
      {of("business").map((def) =>
        def.multi ? (
          <MultiKind key={def.kind} ctx={ctx} def={def} highlight={highlight} />
        ) : (
          <div key={def.kind} className="acc-grid one">
            <SingleCard ctx={ctx} def={def} highlight={highlight} />
          </div>
        ),
      )}

      <SectionHead section="google" title="Google" />
      {banners("google")}
      {of("google").map((def) => (
        <MultiKind key={def.kind} ctx={ctx} def={def} highlight={highlight} hideHead />
      ))}

      <SocialSection ctx={ctx} highlight={highlight} banners={banners("social")} />

      <SectionHead section="settings" title="Settings" />
      {banners("settings")}
      <div className="acc-grid">
        {of("settings").map((def) => (
          <SingleCard key={def.kind} ctx={ctx} def={def} highlight={highlight} />
        ))}
      </div>

      <details className="acc-apps" data-help-pane="accounts.developer-apps" id="acc-apps" open={appsOpen} onToggle={(e) => setAppsOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span className="acc-section-icon" aria-hidden="true">
            <Icon name="code" />
          </span>
          <span className="grow">
            <span className="acc-summary-title">Developer apps</span>
            <span className="small muted acc-summary-sub">
              {appsSet} of {apps.length} set · one-time keys the Connect buttons need
            </span>
          </span>
          <Icon name="chevron" className="acc-chevron" />
        </summary>
        <p className="muted small acc-apps-intro">
          Each platform's sign-in runs through an app you register once in its developer console. Paste its keys here, and add the redirect address shown
          on the card to the app's allowed callbacks. After that, the Connect buttons above sign accounts in without any more copying.
        </p>
        {banners("apps")}
        <div className="acc-grid">
          {apps.map((def) => (
            <SingleCard key={def.kind} ctx={ctx} def={def} highlight={highlight} />
          ))}
        </div>
      </details>
    </>
  );
}

function SectionHead({ section, title, children }: { section: Section; title: string; children?: ReactNode }) {
  return (
    <div className="section-title acc-section-title" id={`acc-section-${section}`}>
      <h3>
        <span className="acc-section-icon" aria-hidden="true">
          <Icon name={SECTION_ICONS[section]} />
        </span>
        {title}
      </h3>
      {children}
    </div>
  );
}

/** Descriptions use `backticks` for commands. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part))}
    </>
  );
}

function HelpLink({ def }: { def: KindDef }) {
  if (!def.helpUrl) return null;
  return (
    <a className="acc-help" href={def.helpUrl} target="_blank" rel="noreferrer">
      Where to get it <Icon name="external" size={14} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function SingleCard({ ctx, def, highlight }: { ctx: Ctx; def: KindDef; highlight: string | null }) {
  const entry = ctx.view.entries.find((e) => e.kind === def.kind);
  return <EntryCard ctx={ctx} def={def} entry={entry} id={DEFAULT_ID} highlight={highlight} />;
}

function MultiKind({ ctx, def, highlight, hideHead }: { ctx: Ctx; def: KindDef; highlight: string | null; hideHead?: boolean }) {
  const entries = ctx.view.entries.filter((e) => e.kind === def.kind);
  const add = () => ctx.open(def.oauth ? { type: "add", kinds: [def], title: `Add ${def.label.toLowerCase()}` } : { type: "edit", def });
  return (
    <div className="acc-kind">
      <div className="acc-kind-head">
        <div className="grow">
          {!hideHead && <h4>{/x$/.test(def.label) ? `${def.label}es` : `${def.label}s`}</h4>}
          <p className="muted small">
            <Rich text={def.description} /> <HelpLink def={def} />
          </p>
        </div>
        <button type="button" onClick={add}>
          <Icon name="plus" /> Add {def.oauth ? "account" : def.label.toLowerCase()}
        </button>
      </div>
      {entries.length ? (
        <div className="acc-grid">
          {entries.map((e) => (
            <EntryCard key={e.id} ctx={ctx} def={def} entry={e} id={e.id} highlight={highlight} />
          ))}
        </div>
      ) : (
        <p className="acc-none small muted">None connected yet.</p>
      )}
    </div>
  );
}

function SocialSection({ ctx, highlight, banners }: { ctx: Ctx; highlight: string | null; banners: ReactNode }) {
  const verticals = useContext(VerticalsContext);
  const social = ctx.view.kinds.filter((k) => k.section === "social");
  const entries = ctx.view.entries.filter((e) => social.some((k) => k.kind === e.kind));
  const byVertical = new Map<string, EntryView[]>();
  for (const e of entries) {
    const v = typeof e.data.vertical === "string" ? e.data.vertical : "";
    byVertical.set(v, [...(byVertical.get(v) ?? []), e]);
  }
  const order = [...Object.keys(verticals), ""];
  const groups = [...byVertical.entries()].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const add = (vertical?: string) => ctx.open({ type: "add", kinds: social, title: vertical ? `Add a ${verticals[vertical]?.name ?? vertical} account` : "Add a social account", vertical });
  return (
    <>
      <SectionHead section="social" title="Social">
        <button type="button" onClick={() => add()}>
          <Icon name="plus" /> Add account
        </button>
      </SectionHead>
      {banners}
      {!entries.length && (
        <Empty icon="social">
          No social accounts yet. Add {social.map((k) => k.label).join(", ").replace(/, ([^,]*)$/, " or $1")} for each business, then post to them from the
          Social page.
        </Empty>
      )}
      {groups.map(([v, list]) => (
        <div key={v || "none"} className="acc-kind">
          <div className="acc-kind-head acc-vertical-head">
            <div className="grow">{v ? <VTag id={v}>{verticals[v]?.name ?? v}</VTag> : <span className="tag">No business</span>}</div>
          </div>
          <div className="acc-grid">
            {list.map((e) => (
              <EntryCard key={`${e.kind}/${e.id}`} ctx={ctx} def={ctx.kinds.get(e.kind)!} entry={e} id={e.id} highlight={highlight} social />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

const TONE_CLASS = { ok: "acc-ok", info: "acc-info", warn: "acc-warn", bad: "acc-bad", none: "acc-none-pill" } as const;

function EntryCard({ ctx, def, entry, id, highlight, social }: { ctx: Ctx; def: KindDef; entry?: EntryView; id: string; highlight: string | null; social?: boolean }) {
  const status = entryStatus(entry, def);
  const [test, setTest] = useState<{ ok: boolean; message: string; at: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const anchor = cardId(def.kind, id);
  const vertical = typeof entry?.data.vertical === "string" ? entry.data.vertical : undefined;
  const title = entry ? entryTitle(def, entry) : def.label;
  const busy = ctx.busy?.endsWith(`:${def.kind}:${id}`);
  const lastTest = test ?? entry?.meta.lastTest ?? null;

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await ctx.api.testIntegration(def.kind, id);
      setTest({ ok: r.ok, message: r.message, at: new Date().toISOString() });
    } catch (e) {
      setTest({ ok: false, message: (e as Error).message, at: new Date().toISOString() });
    } finally {
      setTesting(false);
    }
  };

  const facts = entry ? factsOf(def, entry) : [];
  const providers = APP_PROVIDERS[def.kind];

  return (
    <article className={`card acc-card ${highlight === anchor ? "hl" : ""} ${entry ? "" : "unset"}`} id={anchor} aria-labelledby={`${anchor}-t`}>
      <div className="acc-card-head">
        {social && <span className={`acc-platform p-${def.kind}`} aria-hidden="true" />}
        <div className="grow">
          <h4 id={`${anchor}-t`} className="acc-name">
            {title}
          </h4>
          {(def.multi || social) && entry && (
            <div className="meta">
              {social && <span>{platformLabel(def.kind)}</span>}
              {!social && vertical && <VTag id={vertical} />}
              {entryTitle(def, entry) !== entry.id && <span className="acc-id">{entry.id}</span>}
            </div>
          )}
        </div>
        <span className={`status acc-pill ${TONE_CLASS[status.tone]} ${status.tone === "ok" ? "has-icon" : ""}`}>
          {status.tone === "ok" && <Icon name="check" size={13} />}
          {status.label}
        </span>
      </div>
      {!def.multi && (
        <p className="muted small acc-desc">
          <Rich text={def.description} /> <HelpLink def={def} />
        </p>
      )}
      {status.detail && <p className="error small acc-detail">{status.detail}</p>}
      {facts.length > 0 && (
        <dl className="acc-facts">
          {facts.map(([k, v, mono]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd className={mono ? "mono" : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {lastTest && (
        <p className={`acc-test small ${lastTest.ok ? "ok" : "bad"}`} role={test ? "status" : undefined}>
          <Icon name={lastTest.ok ? "check" : "x"} size={14} />
          <span>
            {lastTest.ok ? "Test passed" : "Test failed"} {ago(lastTest.at)}: {lastTest.message}
          </span>
        </p>
      )}
      {providers && <RedirectUris base={ctx.view.publicBaseUrl} providers={providers} />}
      <div className="acc-actions">
        {def.oauth && (
          <button type="button" className={entry && status.tone !== "warn" && status.tone !== "bad" ? "" : "primary"} disabled={busy} onClick={() => void ctx.connect(def, id, vertical)}>
            <Icon name="link" /> {entry && entryStatus(entry, def).label !== "Not connected" ? "Reconnect" : "Connect"}
          </button>
        )}
        {def.connect === "claude" && (
          <button type="button" className={entry?.secrets.oauthToken ? "" : "primary"} disabled={busy} onClick={() => ctx.open({ type: "claude" })}>
            <Icon name="link" /> {entry?.secrets.oauthToken ? "Reconnect" : "Connect"}
          </button>
        )}
        {!entry && !def.oauth && (
          <button type="button" className={def.connect ? "" : "primary"} onClick={() => ctx.open({ type: "edit", def })}>
            <Icon name={def.connect ? "key" : "plus"} /> {def.connect ? "Paste a token" : "Set up"}
          </button>
        )}
        {entry && (
          <button type="button" onClick={() => ctx.open({ type: "edit", def, entry })} aria-label={`Edit ${title}`}>
            <Icon name="edit" /> Edit
          </button>
        )}
        {entry && def.kind === "google" && (
          <button type="button" onClick={() => ctx.open({ type: "calendars", entry })}>
            <Icon name="today" /> Calendars
          </button>
        )}
        {entry && def.testable && (
          <button type="button" disabled={testing} onClick={runTest} aria-label={`Test ${title}`}>
            <Icon name="pulse" /> {testing ? "Testing…" : "Test"}
          </button>
        )}
        {entry?.source === "railway" && (
          <button type="button" disabled={busy} onClick={() => void ctx.run(`import:${def.kind}:${id}`, "Moved into the app", () => ctx.api.importIntegration(def.kind, id))}>
            <Icon name="install" /> Move into app
          </button>
        )}
        {entry?.source === "app" && (
          <button type="button" className="ghost danger acc-remove" onClick={() => ctx.open({ type: "remove", def, entry })} aria-label={`Disconnect ${title}`}>
            <Icon name="trash" /> Disconnect
          </button>
        )}
      </div>
    </article>
  );
}

/** What a card lists: who it's signed in as, a few settings, and the masked secrets. */
function factsOf(def: KindDef, entry: EntryView): [string, string, boolean?][] {
  const out: [string, string, boolean?][] = [];
  if (entry.meta.account) out.push(["Signed in as", entry.meta.account]);
  const shownInTitle = new Set(["vertical", "displayName", "handle"]);
  let n = 0;
  for (const f of def.fields) {
    if (f.type === "secret" || f.type === "json" || f.type === "list" || f.type === "boolean" || shownInTitle.has(f.key)) continue;
    const v = entry.data[f.key];
    if (v === undefined || v === null || v === "" || (f.key === "email" && v === entry.meta.account)) continue;
    if (n++ >= 4) break;
    out.push([f.label, String(v)]);
  }
  if (def.kind === "google") {
    const cals = chosenCalendars(entry);
    out.push(["Calendars", cals.map((c) => c.name ?? (c.id === "primary" ? "Primary" : c.id)).join(", ")]);
  }
  for (const f of def.fields.filter((f) => f.type === "secret")) {
    const m = entry.secrets[f.key];
    if (m) out.push([f.label, m, true]);
  }
  if (entry.meta.expiresAt) out.push(["Token expires", new Date(entry.meta.expiresAt).toLocaleDateString()]);
  if (entry.updatedAt && entry.source === "app") out.push(["Changed", ago(entry.updatedAt)]);
  return out;
}

function RedirectUris({ base, providers }: { base: string | null; providers: string[] }) {
  if (!base)
    return (
      <p className="small muted acc-redirect-missing">
        Set <code>PUBLIC_BASE_URL</code> in Railway to see the redirect address to register.
      </p>
    );
  return (
    <div className="acc-redirects">
      <div className="small muted">{providers.length > 1 ? "Redirect addresses to register" : "Redirect address to register"}</div>
      {providers.map((p) => {
        const uri = redirectUri(base, p)!;
        return (
          <div key={p} className="acc-redirect">
            {providers.length > 1 && <span className="acc-redirect-label small">{platformLabel(p) === p ? p[0]!.toUpperCase() + p.slice(1) : platformLabel(p)}</span>}
            <code className="grow">{uri}</code>
            <CopyButton text={uri} label={`${p} redirect address`} />
          </div>
        );
      })}
    </div>
  );
}

function RailwayOnly({ view }: { view: IntegrationsView }) {
  return (
    <>
      <div className="section-title acc-section-title">
        <h3>
          <span className="acc-section-icon" aria-hidden="true">
            <Icon name="server" />
          </span>
          Set in Railway
        </h3>
      </div>
      <div className="card acc-railway">
        <p className="muted small">The server needs these before it can read its database, so they stay in Railway's variables.</p>
        <ul className="list">
          {view.railwayOnly.map((r) => (
            <li key={r.name} className="row">
              <span className="grow">
                <span className="acc-rw-label">{r.label}</span>
                <code className="acc-rw-name">{r.name}</code>
              </span>
              <span className={`status acc-pill ${r.set ? "acc-ok" : "acc-none-pill"}`}>{r.set ? "Set" : "Not set"}</span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// --- dialogs ---
function DialogFor({ ctx, dialog, close, openApps }: { ctx: Ctx; dialog: DialogState; close: () => void; openApps: () => void }) {
  switch (dialog.type) {
    case "edit":
      return <EditDialog ctx={ctx} {...dialog} close={close} />;
    case "add":
      return <AddDialog ctx={ctx} {...dialog} close={close} />;
    case "needsApp":
      return (
        <Dialog
          title={`${dialog.app.label} needed`}
          onClose={close}
          footer={
            <>
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  openApps();
                  ctx.open({ type: "edit", def: dialog.app });
                }}
              >
                <Icon name="key" /> Add the keys
              </button>
            </>
          }
        >
          <p>
            Connecting {dialog.def.label} signs in through your own <strong>{dialog.app.label}</strong>, and its keys aren't set yet. It's a one-time setup in
            the developer console:
          </p>
          <p className="muted small">
            <Rich text={dialog.app.description} /> <HelpLink def={dialog.app} />
          </p>
          {APP_PROVIDERS[dialog.app.kind] && <RedirectUris base={ctx.view.publicBaseUrl} providers={APP_PROVIDERS[dialog.app.kind]!} />}
          <p className="muted small">Once the keys are saved, press Connect again.</p>
        </Dialog>
      );
    case "remove":
      return <RemoveDialog ctx={ctx} def={dialog.def} entry={dialog.entry} close={close} />;
    case "calendars":
      return <CalendarDialog ctx={ctx} entry={dialog.entry} close={close} />;
    case "claude":
      return <ClaudeDialog ctx={ctx} close={close} />;
  }
}

/**
 * Connect Claude: the server runs `claude setup-token`. Step 1 opens its claude.ai sign-in link
 * in a new tab; claude.ai then shows a code, which step 2 sends back. The token never reaches
 * the browser: the server saves it and switches agents to Claude.
 */
function ClaudeDialog({ ctx, close }: { ctx: Ctx; close: () => void }) {
  const [setup, setSetup] = useState<{ setupId: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [working, setWorking] = useState(false);
  const finished = useRef(false);
  const setupId = useRef<string | null>(null);

  useEffect(() => {
    ctx.api.claudeSetupStart().then(
      (s) => {
        setupId.current = s.setupId;
        setSetup(s);
      },
      (e: Error) => setError(e.message),
    );
    // Closing without finishing stops the CLI on the server.
    return () => {
      if (setupId.current && !finished.current) void ctx.api.claudeSetupCancel(setupId.current).catch(() => {});
    };
  }, []);

  const finish = async () => {
    if (!setup) return;
    setWorking(true);
    finished.current = true;
    await ctx.run("claude:setup", "Claude connected: agents now run on your subscription", () => ctx.api.claudeSetupCode(setup.setupId, code));
    close();
  };

  return (
    <Dialog
      title="Connect Claude"
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!setup || !code.trim() || working} onClick={finish}>
            {working ? "Connecting…" : "Finish"}
          </button>
        </>
      }
    >
      {error && (
        <ErrorBanner>
          {error} You can still use <strong>Paste a token</strong> from <code>claude setup-token</code> on a computer.
        </ErrorBanner>
      )}
      {!setup && !error && (
        <>
          <p className="muted small">Starting Claude's sign-in on the server…</p>
          <Skeleton rows={2} />
        </>
      )}
      {setup && (
        <ol className="acc-steps">
          <li>
            <p>Sign in with the Claude account whose subscription the agents should use.</p>
            <a className={`button-link ${opened ? "" : "primary"}`} href={setup.url} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
              <Icon name="external" /> Open Claude sign-in
            </a>
          </li>
          <li>
            <label className="acc-field" htmlFor="claude-code">
              <span>Paste the code the sign-in page shows</span>
              <input
                id="claude-code"
                className="mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="Code from claude.ai"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim() && !working) void finish();
                }}
              />
            </label>
          </li>
        </ol>
      )}
      <p className="muted small">The sign-in link works for 10 minutes. The token is saved encrypted on the server; it never comes to this page.</p>
    </Dialog>
  );
}

function RemoveDialog({ ctx, def, entry, close }: { ctx: Ctx; def: KindDef; entry: EntryView; close: () => void }) {
  const title = entryTitle(def, entry);
  const [working, setWorking] = useState(false);
  return (
    <Dialog
      title={`Disconnect ${title}?`}
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            disabled={working}
            onClick={async () => {
              setWorking(true);
              await ctx.run(`remove:${def.kind}:${entry.id}`, "Disconnected", () => ctx.api.removeIntegration(def.kind, entry.id));
              close();
            }}
          >
            <Icon name="trash" /> {working ? "Disconnecting…" : "Disconnect"}
          </button>
        </>
      }
    >
      <p>Command Centre stops using {def.multi ? `this ${def.label} account` : def.label} straight away and forgets its saved keys.</p>
      <p className="muted small">If the same thing is also set in Railway's variables, that value is used again.</p>
    </Dialog>
  );
}

function verticalField(def: KindDef): FieldDef | undefined {
  return def.fields.find((f) => f.key === "vertical");
}

function VerticalSelect({ field, value, onChange, id }: { field: FieldDef; value: string; onChange: (v: string) => void; id: string }) {
  const verticals = useContext(VerticalsContext);
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">Choose…</option>}
      {(field.options ?? []).map((o) => (
        <option key={o} value={o}>
          {verticals[o]?.name ?? o}
        </option>
      ))}
    </select>
  );
}

/** Step one of adding an account: platform (social), business and a name. OAuth kinds then sign in; others go to the form. */
function AddDialog({ ctx, kinds, title, vertical: presetVertical, close }: { ctx: Ctx; kinds: KindDef[]; title: string; vertical?: string; close: () => void }) {
  const [kind, setKind] = useState(kinds[0]!.kind);
  const def = ctx.kinds.get(kind)!;
  const vf = verticalField(def);
  const [vertical, setVertical] = useState(presetVertical ?? String(vf?.default ?? vf?.options?.[0] ?? ""));
  const taken = ctx.view.entries.filter((e) => e.kind === kind).map((e) => e.id);
  const [id, setId] = useState<string | null>(null);
  const shownId = id ?? suggestId(vertical, kind, taken);
  const [error, setError] = useState<string | null>(null);
  const connecting = ctx.busy === `connect:${kind}:${shownId}`;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isValidId(shownId)) return setError("Use letters, digits, - or _ (e.g. dms-instagram).");
    if (taken.includes(shownId)) return setError(`There is already a ${def.label} account called ${shownId}.`);
    if (vf?.required && !vertical) return setError("Choose a business.");
    setError(null);
    if (def.oauth) void ctx.connect(def, shownId, vertical || undefined);
    else ctx.open({ type: "edit", def, id: shownId, vertical });
  };
  return (
    <Dialog
      title={title}
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="acc-add" className="primary" disabled={connecting}>
            {def.oauth ? (
              <>
                <Icon name="link" /> {connecting ? "Opening sign-in…" : `Continue to ${platformLabel(def.oauth) === def.oauth ? def.label : platformLabel(def.oauth)}`}
              </>
            ) : (
              "Next"
            )}
          </button>
        </>
      }
    >
      <form id="acc-add" className="acc-form" onSubmit={submit} noValidate>
        {kinds.length > 1 && (
          <fieldset className="acc-field">
            <legend>Platform</legend>
            <div className="chips acc-platforms">
              {kinds.map((k) => (
                <label key={k.kind} className={`chip ${k.kind === kind ? "on" : ""}`}>
                  <input type="radio" name="platform" value={k.kind} checked={k.kind === kind} onChange={() => setKind(k.kind)} />
                  <span className={`acc-platform p-${k.kind}`} aria-hidden="true" />
                  {k.label}
                </label>
              ))}
            </div>
            <p className="muted small acc-hint">
              <Rich text={def.description} />
            </p>
          </fieldset>
        )}
        {kinds.length === 1 && (
          <p className="muted small">
            <Rich text={def.description} />
          </p>
        )}
        {vf && (
          <div className="acc-field">
            <label htmlFor="acc-add-vertical">{vf.label}</label>
            <VerticalSelect id="acc-add-vertical" field={vf} value={vertical} onChange={setVertical} />
            {vf.help && <span className="muted small">{vf.help}</span>}
          </div>
        )}
        <div className="acc-field">
          <label htmlFor="acc-add-id">Name</label>
          <input
            id="acc-add-id"
            value={shownId}
            onChange={(e) => setId(e.target.value.toLowerCase())}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="acc-add-id-help"
            aria-invalid={!!error}
          />
          <span id="acc-add-id-help" className="muted small">
            A short id agents refer to it by: letters, digits, - or _.
          </span>
        </div>
        {def.oauth && def.needsApp && !ctx.view.entries.some((e) => e.kind === def.needsApp) && (
          <p className="acc-hint warn small">
            <Icon name="alert" size={14} /> {ctx.kinds.get(def.needsApp)?.label} isn't set up yet. You'll be asked for its keys first.
          </p>
        )}
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </form>
    </Dialog>
  );
}

function EditDialog({ ctx, def, entry, id: newId, vertical, close }: { ctx: Ctx; def: KindDef; entry?: EntryView; id?: string; vertical?: string; close: () => void }) {
  const isNew = !entry;
  const needsId = isNew && def.multi && !newId;
  const fields = editableFields(def);
  const [values, setValues] = useState<FormValues>(() => {
    const v = { ...initialValues(def, entry), ...(vertical ? { vertical } : {}) };
    // A new account starts in the first business, so the suggested name reads e.g. "personal-email".
    const vf = verticalField(def);
    if (isNew && vf && !v.vertical && vf.options?.length) v.vertical = vf.options[0]!;
    return v;
  });
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const taken = ctx.view.entries.filter((e) => e.kind === def.kind).map((e) => e.id);
  const [idValue, setIdValue] = useState<string | null>(null);
  const id = entry?.id ?? newId ?? (def.multi ? (idValue ?? suggestId(String(values.vertical ?? ""), def.kind, taken)) : DEFAULT_ID);
  const title = entry ? `Edit ${entryTitle(def, entry)}` : def.multi ? `Add ${def.label.toLowerCase()}` : `Set up ${def.label}`;

  const set = (k: string, v: string | boolean) => setValues((s) => ({ ...s, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validate(def, values, entry, cleared);
    if (needsId && !isValidId(id)) errs.__id = "Use letters, digits, - or _ (e.g. dms-email).";
    else if (needsId && taken.includes(id)) errs.__id = `There is already one called ${id}.`;
    setErrors(errs);
    if (Object.keys(errs).length) {
      document.getElementById(`acc-f-${Object.keys(errs)[0]}`)?.focus();
      return;
    }
    setSaving(true);
    setServerError(null);
    try {
      const result = await ctx.api.saveIntegration(def.kind, id, toPatch(def, values, { isNew, cleared }));
      ctx.notify(describeResult(result, isNew ? `${def.label} saved` : "Saved"));
      ctx.reload();
      close();
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={title}
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" form="acc-edit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="acc-edit" data-help-pane="accounts.connect" className="acc-form" onSubmit={submit} noValidate>
        <p className="muted small">
          <Rich text={def.description} /> <HelpLink def={def} />
        </p>
        {entry?.source === "railway" && <p className="acc-hint info small">This is set in Railway. Saving copies it into the app with your changes; you can then delete the Railway variable.</p>}
        {def.kind === "email" && (
          <div className="acc-preset">
            <button type="button" className="small" onClick={() => setValues((s) => ({ ...s, ...GMAIL_PRESET }))}>
              <Icon name="mail" size={14} /> Fill in Gmail settings
            </button>
            <span className="muted small">Then use an app password, not your Google password.</span>
          </div>
        )}
        {needsId && (
          <div className="acc-field">
            <label htmlFor="acc-f-__id">Name</label>
            <input
              id="acc-f-__id"
              value={id}
              onChange={(e) => setIdValue(e.target.value.toLowerCase())}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={!!errors.__id}
              aria-describedby="acc-f-__id-help"
            />
            <span id="acc-f-__id-help" className={errors.__id ? "error small" : "muted small"}>
              {errors.__id ?? "A short id agents refer to it by: letters, digits, - or _."}
            </span>
          </div>
        )}
        {fields.map((f) => (
          <FieldInput
            key={f.key}
            field={f}
            value={values[f.key] ?? ""}
            onChange={(v) => set(f.key, v)}
            current={entry?.secrets[f.key] ?? null}
            cleared={cleared.has(f.key)}
            onClear={(c) =>
              setCleared((s) => {
                const n = new Set(s);
                if (c) n.add(f.key);
                else n.delete(f.key);
                return n;
              })
            }
            error={errors[f.key]}
            googleIds={f.key === "googleAccount" ? ctx.view.entries.filter((e) => e.kind === "google").map((e) => e.id) : undefined}
          />
        ))}
        {serverError && <ErrorBanner>{serverError}</ErrorBanner>}
      </form>
    </Dialog>
  );
}

function FieldInput({
  field: f,
  value,
  onChange,
  current,
  cleared,
  onClear,
  error,
  googleIds,
}: {
  field: FieldDef;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
  current: string | null;
  cleared: boolean;
  onClear: (c: boolean) => void;
  error?: string;
  googleIds?: string[];
}) {
  const id = `acc-f-${f.key}`;
  const helpId = `${id}-help`;
  const help = error ?? f.help;
  const described = help ? helpId : undefined;
  const str = typeof value === "string" ? value : "";
  const helpEl = help && (
    <span id={helpId} className={error ? "error small" : "muted small"}>
      {help}
    </span>
  );
  const label = (
    <label htmlFor={id}>
      {f.label}
      {f.required && <span className="acc-req" aria-hidden="true"> *</span>}
    </label>
  );

  if (f.type === "boolean")
    return (
      <div className="acc-field acc-switch-row">
        <label className="acc-switch" htmlFor={id}>
          <input id={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} aria-describedby={described} />
          <span className="acc-switch-track" aria-hidden="true" />
          <span>{f.label}</span>
        </label>
        {helpEl}
      </div>
    );

  let control: ReactNode;
  const common = { id, "aria-invalid": !!error, "aria-describedby": described, required: f.required } as const;
  switch (f.type) {
    case "secret":
      control = (
        <div className="acc-secret">
          <input
            {...common}
            required={f.required && !current}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            disabled={cleared}
            value={cleared ? "" : str}
            placeholder={cleared ? "Will be cleared" : current ? `${current} (leave blank to keep)` : (f.placeholder ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
          {current && (
            <button type="button" className={`small ${cleared ? "" : "danger-text"}`} onClick={() => onClear(!cleared)} aria-pressed={cleared} aria-label={cleared ? `Keep ${f.label}` : `Clear ${f.label}`}>
              {cleared ? "Undo" : "Clear"}
            </button>
          )}
        </div>
      );
      break;
    case "select":
      control =
        f.key === "vertical" ? (
          <VerticalSelect id={id} field={f} value={str} onChange={onChange} />
        ) : (
          <select {...common} value={str} onChange={(e) => onChange(e.target.value)}>
            {!f.required && <option value="">{f.default !== undefined ? `Default (${String(f.default)})` : "Not set"}</option>}
            {(f.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        );
      break;
    case "list":
      control = <textarea {...common} rows={3} value={str} placeholder="One per line" onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
      break;
    case "json":
      control = <textarea {...common} rows={4} className="mono" value={str} placeholder={typeof f.default === "string" ? f.default : "{}"} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
      break;
    default:
      control = (
        <>
          <input
            {...common}
            type={f.type === "number" ? "number" : f.type === "email" ? "email" : f.type === "url" ? "url" : "text"}
            inputMode={f.type === "number" ? "numeric" : undefined}
            value={str}
            placeholder={f.placeholder ?? (f.default !== undefined ? String(f.default) : "")}
            onChange={(e) => onChange(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            list={googleIds ? `${id}-list` : undefined}
          />
          {googleIds && (
            <datalist id={`${id}-list`}>
              {googleIds.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          )}
        </>
      );
  }
  return (
    <div className="acc-field">
      {label}
      {control}
      {helpEl}
    </div>
  );
}

function CalendarDialog({ ctx, entry, close }: { ctx: Ctx; entry: EntryView; close: () => void }) {
  const [list, setList] = useState<{ id: string; name?: string; primary?: boolean; accessRole?: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = chosenCalendars(entry);
  const [chosen, setChosen] = useState<Set<string>>(new Set(current.map((c) => c.id)));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    ctx.api.googleCalendars(entry.id).then(
      (r) => {
        setList(r.calendars.map((c) => ({ ...c, name: c.name ?? c.summary })));
        // "primary" is an alias: tick the real primary calendar instead.
        const primary = r.calendars.find((c) => c.primary);
        if (primary && chosen.has("primary")) setChosen((s) => new Set([...s].filter((x) => x !== "primary").concat(primary.id)));
      },
      (e: Error) =>
        setError(
          e instanceof ApiError && e.status === 404
            ? "This server can't list calendars yet. Use Edit and type the calendar ids into the Calendars field instead."
            : e.message,
        ),
    );
  }, [entry.id]);

  const save = async () => {
    setSaving(true);
    try {
      const prev = new Map(current.map((c) => [c.id, c]));
      const picked = (list ?? []).filter((c) => chosen.has(c.id)).map((c) => ({ ...prev.get(c.id), id: c.id, ...(c.name ? { name: c.name } : {}) }));
      await ctx.run(`cal:google:${entry.id}`, "Calendars saved", () => ctx.api.saveIntegration("google", entry.id, { data: { calendars: JSON.stringify(picked) } }));
      close();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Choose calendars"
      onClose={close}
      footer={
        <>
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!list || saving || chosen.size === 0} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <p className="muted small">The personal assistant reads these calendars{entry.meta.account ? ` from ${entry.meta.account}` : ""}.</p>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!list && !error && <Skeleton rows={2} />}
      {list && (
        <fieldset className="acc-field">
          <legend className="sr-only">Calendars</legend>
          <ul className="list acc-cals">
            {list.map((c) => (
              <li key={c.id}>
                <label className="acc-cal">
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={(e) =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(c.id);
                        else n.delete(c.id);
                        return n;
                      })
                    }
                  />
                  <span className="grow">
                    {c.name ?? c.id}
                    {c.primary && <span className="tag acc-cal-tag">Primary</span>}
                  </span>
                  {c.accessRole && <span className="small muted">{c.accessRole === "owner" ? "Yours" : c.accessRole === "reader" ? "Read only" : c.accessRole}</span>}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
    </Dialog>
  );
}
