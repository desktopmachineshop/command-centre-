import { type FormEvent, useState } from "react";
import { type Connection, createApi } from "../api";

export function Login({ onConnect }: { onConnect: (c: Connection) => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const conn = { baseUrl: baseUrl.trim(), token: token.trim() };
    try {
      await createApi(conn).stats();
      onConnect(conn);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="card" onSubmit={submit}>
        <h1>Command Centre</h1>
        <label>
          Server URL <span className="muted small">(blank for this site)</span>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://cc.example.com" inputMode="url" />
        </label>
        <label>
          Admin token
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" required autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
