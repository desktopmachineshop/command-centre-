import { useState } from "react";
import type { Api } from "../api";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function Settings({ api, onSignOut }: { api: Api; onSignOut: () => void }) {
  const [status, setStatus] = useState<string | null>(null);

  const enablePush = async () => {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This browser does not support push. On iPhone, add the app to the home screen first.");
      const { publicKey } = await api.pushKey();
      if (!publicKey) throw new Error("Push is not configured on the server (VAPID keys missing).");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notification permission denied.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api.pushSubscribe(sub.toJSON());
      setStatus("Notifications enabled on this device.");
    } catch (e) {
      setStatus((e as Error).message);
    }
  };

  return (
    <section>
      <h2>Settings</h2>
      <div className="card">
        <h3>Notifications</h3>
        <p className="muted small">Get a push notification when an action needs your approval.</p>
        <button className="primary" onClick={enablePush}>
          Enable on this device
        </button>
        {status && <p className="small">{status}</p>}
      </div>
      <div className="card">
        <h3>Connection</h3>
        <button onClick={onSignOut}>Sign out</button>
      </div>
    </section>
  );
}
