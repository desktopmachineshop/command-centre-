import {
  CATEGORY_LABELS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PRIORITIES,
  type NotificationCategory,
  type NotificationDevice,
  type NotificationPrefs,
  type NotificationPriority,
  type VerticalManifest,
} from "@cc/core";
import { useEffect, useState } from "react";
import type { Api } from "../api";
import { ago } from "../format";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Mac/.test(ua)) return "Mac";
  return "This device";
}

const DELIVERY = [
  ["push", "Push now"],
  ["digest", "Next digest"],
  ["silent", "In app only"],
] as const;

const ROUTING: Record<NotificationPriority, string> = {
  low: "Everything",
  normal: "Normal and up",
  high: "High and urgent",
  urgent: "Urgent only",
};

/** Notification settings: categories × (on, delivery, sound), quiet hours, quick briefing, devices and test pushes. */
export function NotificationSettings({ api }: { api: Api }) {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [devices, setDevices] = useState<NotificationDevice[]>([]);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [verticals, setVerticals] = useState<VerticalManifest[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDevices = () =>
    api.devices().then((d) => {
      setDevices(d.devices);
      setPublicKey(d.publicKey);
    });
  useEffect(() => {
    api.notificationPrefs().then((p) => setPrefs(p.prefs), (e: Error) => setError(e.message));
    api.verticals().then(setVerticals, () => {});
    loadDevices().catch((e: Error) => setError(e.message));
  }, [api]);

  const save = async (patch: Partial<NotificationPrefs>) => {
    setError(null);
    try {
      setPrefs((await api.saveNotificationPrefs(patch)).prefs);
      setStatus("Saved.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const setCategory = (c: NotificationCategory, patch: Partial<NotificationPrefs["categories"][NotificationCategory]>) =>
    save({ categories: { [c]: patch } } as Partial<NotificationPrefs>);
  const test = async (options: { category?: NotificationCategory; deviceId?: string }) => {
    try {
      const r = await api.testNotification(options);
      setStatus(r.pushConfigured ? "Test sent." : "Saved in Notifications; push is not configured on the server (VAPID keys missing).");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const enableHere = async () => {
    setError(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window))
        throw new Error("This browser does not support push. On iPhone, add the app to the home screen and open it from there.");
      if (!publicKey) throw new Error("Push is not configured on the server (VAPID keys missing).");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notification permission denied.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const name = prompt("Name this device", guessDeviceName()) ?? undefined;
      await api.addDevice(sub.toJSON(), name || undefined);
      await loadDevices();
      setStatus("Notifications enabled on this device.");
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!prefs) return <section>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;
  const q = prefs.quietHours;
  const overrides = Object.entries(prefs.verticals).flatMap(([v, cats]) =>
    Object.entries(cats).map(([c, o]) => ({ vertical: v, category: c as NotificationCategory, o: o! })),
  );

  return (
    <section className="notification-settings">
      <div className="row between">
        <h2>Notification settings</h2>
        <a href="#/notifications" className="small">
          Notifications
        </a>
      </div>
      {status && <p className="small">{status}</p>}
      {error && <p className="error">{error}</p>}

      <div className="card">
        <h3>Categories</h3>
        <div className="table-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">On</th>
                <th scope="col">Delivery</th>
                <th scope="col">Sound</th>
                <th scope="col">Priority</th>
                <th scope="col">Test</th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_CATEGORIES.map((c) => {
                const s = prefs.categories[c];
                return (
                  <tr key={c}>
                    <th scope="row">{CATEGORY_LABELS[c]}</th>
                    <td>
                      <input type="checkbox" aria-label={`${CATEGORY_LABELS[c]} on`} checked={s.enabled} onChange={(e) => setCategory(c, { enabled: e.target.checked })} />
                    </td>
                    <td>
                      <select aria-label={`${CATEGORY_LABELS[c]} delivery`} value={s.delivery} disabled={!s.enabled} onChange={(e) => setCategory(c, { delivery: e.target.value as never })}>
                        {DELIVERY.filter(([d]) => !(c === "digest" && d === "digest")).map(([d, label]) => (
                          <option key={d} value={d}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" aria-label={`${CATEGORY_LABELS[c]} sound`} checked={s.sound} disabled={!s.enabled} onChange={(e) => setCategory(c, { sound: e.target.checked })} />
                    </td>
                    <td>
                      <select aria-label={`${CATEGORY_LABELS[c]} priority`} value={s.priority} onChange={(e) => setCategory(c, { priority: e.target.value as NotificationPriority })}>
                        {NOTIFICATION_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button onClick={() => test({ category: c })}>Test</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Urgent always pushes, even in quiet hours. More than {prefs.rateLimit.perCategory} pushes of one category in{" "}
          {prefs.rateLimit.windowMinutes} minutes collapse into one "and N more".
        </p>
        <label className="small">
          Pushes per category per {prefs.rateLimit.windowMinutes} minutes (0 = no limit){" "}
          <input
            type="number"
            min={0}
            max={100}
            value={prefs.rateLimit.perCategory}
            onChange={(e) => save({ rateLimit: { ...prefs.rateLimit, perCategory: Number(e.target.value) } })}
          />
        </label>
      </div>

      <VerticalOverrides verticals={verticals} prefs={prefs} overrides={overrides} save={save} />

      <div className="card">
        <h3>Quiet hours</h3>
        <div className="row wrap">
          <label className="small">
            <input type="checkbox" checked={q.enabled} onChange={(e) => save({ quietHours: { ...q, enabled: e.target.checked } })} /> On
          </label>
          <label className="small">
            From <input type="time" value={q.start} onChange={(e) => e.target.value && save({ quietHours: { ...q, start: e.target.value } })} />
          </label>
          <label className="small">
            To <input type="time" value={q.end} onChange={(e) => e.target.value && save({ quietHours: { ...q, end: e.target.value } })} />
          </label>
          <label className="small">
            Timezone <input value={q.timezone} onChange={(e) => setPrefs({ ...prefs, quietHours: { ...q, timezone: e.target.value } })} onBlur={() => save({ quietHours: q })} />
          </label>
          <label className="small">
            <input type="checkbox" checked={q.allowApprovals} onChange={(e) => save({ quietHours: { ...q, allowApprovals: e.target.checked } })} /> Let approvals through
          </label>
        </div>
        <p className="muted small">Everything else is held and arrives as one summary when quiet hours end.</p>
      </div>

      <div className="card">
        <h3>Quick briefing</h3>
        <p className="muted small">A push with today's counts (approvals waiting, tasks, spend). No agent run.</p>
        <div className="row wrap">
          <label className="small">
            <input
              type="checkbox"
              checked={prefs.quickBriefing.enabled}
              onChange={(e) => save({ quickBriefing: { ...prefs.quickBriefing, enabled: e.target.checked } })}
            />{" "}
            On
          </label>
          <label className="small">
            At{" "}
            <input
              type="time"
              value={prefs.quickBriefing.time}
              onChange={(e) => e.target.value && save({ quickBriefing: { ...prefs.quickBriefing, time: e.target.value } })}
            />
          </label>
        </div>
      </div>

      <div className="card">
        <h3>Devices</h3>
        {!publicKey && <p className="muted small">Push is not configured on the server (set VAPID keys). Notifications still appear in the app.</p>}
        {devices.length === 0 && <p className="muted small">No devices yet.</p>}
        <ul className="list">
          {devices.map((d) => (
            <DeviceRow key={d.id} api={api} device={d} onChange={loadDevices} onTest={() => test({ deviceId: d.id })} />
          ))}
        </ul>
        <button className="primary" onClick={enableHere}>
          Enable on this device
        </button>
      </div>
    </section>
  );
}

function DeviceRow({ api, device, onChange, onTest }: { api: Api; device: NotificationDevice; onChange: () => void; onTest: () => void }) {
  const [name, setName] = useState(device.name ?? "");
  return (
    <li className="card device">
      <div className="row wrap">
        <input aria-label="Device name" value={name} placeholder="Unnamed device" onChange={(e) => setName(e.target.value)} />
        <button disabled={!name.trim() || name === device.name} onClick={() => api.updateDevice(device.id, { name: name.trim() }).then(onChange)}>
          Rename
        </button>
        <select aria-label="Gets" value={device.minPriority} onChange={(e) => api.updateDevice(device.id, { minPriority: e.target.value as NotificationPriority }).then(onChange)}>
          {NOTIFICATION_PRIORITIES.slice()
            .reverse()
            .map((p) => (
              <option key={p} value={p}>
                {ROUTING[p]}
              </option>
            ))}
        </select>
        <button onClick={onTest}>Send test</button>
        <button onClick={() => confirm(`Remove ${device.name ?? "this device"}?`) && api.removeDevice(device.id).then(onChange)}>Remove</button>
      </div>
      <p className="muted small">
        {[device.platform, `added ${ago(device.createdAt)}`, device.lastSuccessAt && `last push ${ago(device.lastSuccessAt)}`, device.lastError && `last error: ${device.lastError}`]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </li>
  );
}

function VerticalOverrides({
  verticals,
  prefs,
  overrides,
  save,
}: {
  verticals: VerticalManifest[];
  prefs: NotificationPrefs;
  overrides: { vertical: string; category: NotificationCategory; o: { enabled?: boolean; delivery?: string; sound?: boolean } }[];
  save: (patch: Partial<NotificationPrefs>) => Promise<void>;
}) {
  const [vertical, setVertical] = useState("");
  const [category, setCategory] = useState<NotificationCategory>("social");
  const [mode, setMode] = useState("off");
  const add = () => {
    if (!vertical) return;
    const o = mode === "off" ? { enabled: false } : { enabled: true, delivery: mode as "push" | "digest" | "silent" };
    save({ verticals: { ...prefs.verticals, [vertical]: { ...prefs.verticals[vertical], [category]: o } } });
  };
  const remove = (v: string, c: NotificationCategory) => {
    const { [c]: _gone, ...rest } = prefs.verticals[v] ?? {};
    const next = { ...prefs.verticals };
    if (Object.keys(rest).length) next[v] = rest;
    else delete next[v];
    save({ verticals: next });
  };
  return (
    <div className="card">
      <h3>Per vertical</h3>
      <p className="muted small">Override a category for one business, e.g. turn off 3dpandme social.</p>
      <ul className="list">
        {overrides.map(({ vertical: v, category: c, o }) => (
          <li key={`${v}/${c}`} className="row between small">
            <span>
              <span className="tag">{v}</span> {CATEGORY_LABELS[c]}: {o.enabled === false ? "off" : (DELIVERY.find(([d]) => d === o.delivery)?.[1] ?? "on")}
            </span>
            <button onClick={() => remove(v, c)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="row wrap">
        <select aria-label="Vertical" value={vertical} onChange={(e) => setVertical(e.target.value)}>
          <option value="">Vertical…</option>
          {verticals.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as NotificationCategory)}>
          {NOTIFICATION_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        <select aria-label="Behaviour" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="off">Off</option>
          {DELIVERY.map(([d, label]) => (
            <option key={d} value={d}>
              {label}
            </option>
          ))}
        </select>
        <button disabled={!vertical} onClick={add}>
          Add override
        </button>
      </div>
    </div>
  );
}
