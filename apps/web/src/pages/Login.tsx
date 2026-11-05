import { type FormEvent, useState } from "react";
import { ApiError, COOKIE_SESSION, type Connection, createApi } from "../api";
import { BrandMark } from "../icons";
import { useTheme } from "../theme";
import { ErrorBanner, ThemeToggle } from "../ui";

type Mode = "password" | "token" | "dmsid-code";

/**
 * Sign-in screen. `setupRequired` (no users yet) shows first-run setup instead.
 * `onSignedIn` gets the connection to use: the cookie session, or an admin-token one.
 */
export function Login({
  setupRequired,
  dmsid = false,
  dmsidCode = false,
  notice,
  onSignedIn,
}: {
  setupRequired: boolean;
  /** Offer "Sign in with DMSid" (the server has it configured). */
  dmsid?: boolean;
  /** Back from DMSid with two-factor on: ask for the authenticator code. */
  dmsidCode?: boolean;
  /** Shown above the form, e.g. when the server could not be reached. */
  notice?: string;
  onSignedIn: (c: Connection) => void;
}) {
  const [mode, setMode] = useState<Mode>(dmsidCode ? "dmsid-code" : "password");
  const [theme, setTheme] = useTheme();

  return (
    <div className="login">
      <div className="login-theme">
        <ThemeToggle value={theme} onChange={setTheme} />
      </div>
      {mode === "dmsid-code" ? (
        <DmsIdCodeForm onSignedIn={onSignedIn} onBack={() => setMode("password")} />
      ) : mode === "token" ? (
        <TokenForm onSignedIn={onSignedIn} onBack={() => setMode("password")} />
      ) : setupRequired ? (
        <SetupForm onSignedIn={onSignedIn} onUseToken={() => setMode("token")} />
      ) : (
        <PasswordForm notice={notice} dmsid={dmsid} onSignedIn={onSignedIn} onUseToken={() => setMode("token")} />
      )}
    </div>
  );
}

const api = createApi(COOKIE_SESSION);

/** Runs a form action with a busy flag and an error message. */
function useSubmit(initialError: string | null = null) {
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
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
  return { error, setError, busy, run };
}

function PasswordForm({
  notice,
  dmsid,
  onSignedIn,
  onUseToken,
}: {
  notice?: string;
  dmsid: boolean;
  onSignedIn: (c: Connection) => void;
  onUseToken: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const { error, setError, busy, run } = useSubmit(notice ?? null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await api.login(email.trim(), password, needsCode ? totp.trim() : undefined);
        onSignedIn(COOKIE_SESSION);
      } catch (err) {
        if (err instanceof ApiError && err.body?.totpRequired) {
          // First time: just move on to the code step without showing an error.
          if (!needsCode) {
            setNeedsCode(true);
            return;
          }
          setTotp("");
        }
        throw err;
      }
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <BrandMark size={52} />
      <h1>Command Centre</h1>
      {needsCode ? (
        <>
          <p className="muted small">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          <label>
            Code
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              required
            />
          </label>
        </>
      ) : (
        <>
          <label>
            Email
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required autoFocus />
          </label>
          <label>
            Password
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
          </label>
        </>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <button className="primary" disabled={busy}>
        {busy ? "Signing in…" : needsCode ? "Verify" : "Sign in"}
      </button>
      {needsCode ? (
        <button type="button" className="link" onClick={() => (setNeedsCode(false), setTotp(""), setError(null))}>
          Back
        </button>
      ) : (
        <>
          {dmsid && (
            <>
              <p className="login-or muted small" aria-hidden="true">
                or
              </p>
              {/* A full-page navigation: the server sends the browser on to DMSid and back. */}
              <a className="button-link" href="/api/auth/dmsid">
                Sign in with DMSid
              </a>
            </>
          )}
          <button type="button" className="link" onClick={onUseToken}>
            Use an admin token instead
          </button>
        </>
      )}
    </form>
  );
}

/** Back from DMSid for an account with two-factor on: the authenticator code completes the sign-in. */
function DmsIdCodeForm({ onSignedIn, onBack }: { onSignedIn: (c: Connection) => void; onBack: () => void }) {
  const [code, setCode] = useState("");
  const { error, busy, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await api.dmsidCode(code.trim());
        onSignedIn(COOKIE_SESSION);
      } catch (err) {
        setCode("");
        throw err;
      }
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <BrandMark size={52} />
      <h1>Command Centre</h1>
      <p className="muted small">Signed in with DMSid. Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
      <label>
        Code
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" autoFocus required />
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <button className="primary" disabled={busy}>
        {busy ? "Signing in…" : "Verify"}
      </button>
      <button type="button" className="link" onClick={onBack}>
        Back
      </button>
    </form>
  );
}

/** First run on a fresh server: the admin token once, plus the account to create. */
function SetupForm({ onSignedIn, onUseToken }: { onSignedIn: (c: Connection) => void; onUseToken: () => void }) {
  const [adminToken, setAdminToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { error, busy, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (password !== confirm) throw new Error("The passwords don't match");
      await api.setup(adminToken.trim(), { name: name.trim(), email: email.trim(), password });
      onSignedIn(COOKIE_SESSION);
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <BrandMark size={52} />
      <h1>Set up Command Centre</h1>
      <p className="muted small">
        Create your account. To prove this server is yours, paste the <code>ADMIN_TOKEN</code> from your Railway variables. You only need it
        this once.
      </p>
      <label>
        Admin token
        <input value={adminToken} onChange={(e) => setAdminToken(e.target.value)} type="password" autoComplete="off" required />
      </label>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
      </label>
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required />
      </label>
      <label>
        Password <span className="muted small">(at least 10 characters)</span>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="new-password" minLength={10} required />
      </label>
      <label>
        Repeat password
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} type="password" autoComplete="new-password" minLength={10} required />
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <button className="primary" disabled={busy}>
        {busy ? "Creating…" : "Create account"}
      </button>
      <button type="button" className="link" onClick={onUseToken}>
        Use an admin token instead
      </button>
    </form>
  );
}

/** The original flow, for advanced use: a token (and optionally another server), kept in this browser. */
function TokenForm({ onSignedIn, onBack }: { onSignedIn: (c: Connection) => void; onBack: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const { error, busy, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const conn = { baseUrl: baseUrl.trim(), token: token.trim() };
      await createApi(conn).stats();
      onSignedIn(conn);
    });
  };

  return (
    <form className="card" onSubmit={submit}>
      <BrandMark size={52} />
      <h1>Command Centre</h1>
      <p className="muted small">Sign in with the server's admin token. It is saved in this browser until you sign out.</p>
      <label>
        Server URL <span className="muted small">(blank for this site)</span>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://cc.example.com" inputMode="url" />
      </label>
      <label>
        Admin token
        <input value={token} onChange={(e) => setToken(e.target.value)} type="password" required autoComplete="current-password" />
      </label>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <button className="primary" disabled={busy}>
        {busy ? "Connecting…" : "Connect"}
      </button>
      <button type="button" className="link" onClick={onBack}>
        Sign in with email and password
      </button>
    </form>
  );
}
