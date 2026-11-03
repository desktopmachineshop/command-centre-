import qrcode from "qrcode-generator";
import { type FormEvent, useEffect, useState } from "react";
import type { Api, Me, SessionInfo } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { ErrorBanner } from "../ui";

/**
 * Settings → account: password, two-factor and signed-in devices. With the admin
 * token there is no account, so only a note is shown.
 */
export function Account({ api }: { api: Api }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api
      .me()
      .then(setMe)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void reload();
  }, [api]);

  if (error) return <ErrorBanner>{error}</ErrorBanner>;
  if (!me) return null;
  if (me.via === "token") {
    return (
      <div className="card">
        <div className="card-head">
          <Icon name="key" />
          <h3>Account</h3>
        </div>
        <p className="muted small">You're signed in with the admin token, which has no account. Sign out and sign in with your email and password to manage it.</p>
      </div>
    );
  }
  return (
    <>
      <div className="card">
        <div className="card-head">
          <Icon name="key" />
          <h3>Account</h3>
        </div>
        <p className="small">
          <strong>{me.user.name}</strong> <span className="muted">· {me.user.email}</span>
        </p>
      </div>
      <ChangePassword api={api} />
      <TwoFactor api={api} me={me} onChange={reload} />
      <Sessions api={api} />
    </>
  );
}

function ChangePassword({ api }: { api: Api }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setStatus({ ok: false, text: "The new passwords don't match" });
    setBusy(true);
    try {
      const { revokedSessions } = await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setStatus({ ok: true, text: `Password changed.${revokedSessions ? ` Signed out ${revokedSessions} other device(s).` : ""}` });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" data-help-pane="settings.password" onSubmit={submit}>
      <div className="card-head">
        <Icon name="key" />
        <h3>Change password</h3>
      </div>
      <p className="muted small">Other devices are signed out when you change it.</p>
      <label>
        Current password
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </label>
      <label>
        New password <span className="muted small">(at least 10 characters)</span>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
      </label>
      <label>
        Repeat new password
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={10} required />
      </label>
      {status && <p className={status.ok ? "small" : "error"}>{status.text}</p>}
      <div>
        <button className="primary" disabled={busy}>
          Change password
        </button>
      </div>
    </form>
  );
}

function TwoFactor({ api, me, onChange }: { api: Api; me: Extract<Me, { via: "session" }>; onChange: () => void }) {
  const [pending, setPending] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = () => act(async () => setPending(await api.totpSetup()));
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const { recoveryCodes } = await api.totpEnable(code.trim());
      setPending(null);
      setCode("");
      setRecovery(recoveryCodes);
      onChange();
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api.totpDisable(password);
      setPassword("");
      setRecovery(null);
      onChange();
    });
  };

  return (
    <div className="card" data-help-pane="settings.two-factor">
      <div className="card-head">
        <Icon name="shield" />
        <h3>Two-factor authentication</h3>
        {me.user.totpEnabled && <span className="status done">On</span>}
      </div>
      {recovery && (
        <>
          <p className="small">
            Two-factor is on. Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone, and they won't be shown
            again.
          </p>
          <pre>{recovery.join("\n")}</pre>
        </>
      )}
      {me.user.totpEnabled ? (
        <form className="form" onSubmit={disable}>
          {!recovery && <p className="muted small">On. {me.recoveryCodesLeft} recovery code(s) left.</p>}
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <div>
            <button className="danger-text" disabled={busy}>
              Turn off two-factor
            </button>
          </div>
        </form>
      ) : pending ? (
        <form className="form" onSubmit={enable}>
          <p className="small">Scan this with your authenticator app (1Password, Google Authenticator, Authy...), then enter the code it shows.</p>
          <img className="qr" src={qrDataUrl(pending.otpauthUrl)} alt="QR code for your authenticator app" width={196} height={196} />
          <p className="small">
            On this phone? <a href={pending.otpauthUrl}>Open in your authenticator app</a>, or enter the key by hand: <code>{pending.secret}</code>
          </p>
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required />
          </label>
          <div className="button-row">
            <button className="primary" disabled={busy}>
              Turn on
            </button>
            <button type="button" className="ghost" onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="muted small">Off. With it on, signing in also needs a code from your phone.</p>
          <button className="primary" onClick={start} disabled={busy}>
            Set up two-factor
          </button>
        </>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  );
}

function qrDataUrl(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createDataURL(4, 4);
}

/** A short device description from the user agent. */
function device(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad|Android|Windows|Mac OS|Linux/.exec(ua)?.[0]?.replace("Mac OS", "Mac") ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, os].filter(Boolean).join(" on ") || ua.slice(0, 60);
}

function Sessions({ api }: { api: Api }) {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () =>
    api
      .sessions()
      .then(setSessions)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void reload();
  }, [api]);

  const revoke = async (id: string) => {
    try {
      await api.revokeSession(id);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const others = sessions?.filter((s) => !s.current).length ?? 0;
  return (
    <div className="card" data-help-pane="settings.sessions">
      <div className="card-head">
        <Icon name="devices" />
        <h3>Signed-in devices</h3>
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <ul className="list">
        {sessions?.map((s) => (
          <li key={s.id} className="row between">
            <span className="grow">
              {device(s.userAgent)} {s.current && <span className="tag">this device</span>}
              <br />
              <span className="muted small">
                {s.ip ?? "unknown IP"} · active {ago(s.lastSeenAt)} · signed in {ago(s.createdAt)}
              </span>
            </span>
            {!s.current && (
              <button className="small" onClick={() => revoke(s.id)} aria-label={`Sign out ${device(s.userAgent)}`}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
      {others > 1 && (
        <button className="danger-text" style={{ marginTop: 8 }} onClick={() => revoke("others")}>
          Sign out all other devices
        </button>
      )}
    </div>
  );
}
