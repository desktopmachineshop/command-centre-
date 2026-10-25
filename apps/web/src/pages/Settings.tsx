import { useState } from "react";
import { useInstall } from "../install";
import type { Api } from "../api";
import { Icon } from "../icons";
import { PageHead } from "../ui";
import { Account } from "./Account";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function Settings({ api, onSignOut }: { api: Api; onSignOut: () => void }) {
  const install = useInstall();
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
    <section className="settings-grid">
      <PageHead title="Settings" />
      <div className="card">
        <div className="card-head">
          <Icon name="install" />
          <h3>App</h3>
        </div>
        {install.installed ? (
          <p className="small muted">Installed: you're using the Command Centre app.</p>
        ) : install.blocked ? (
          <p className="error small">
            Can't install from here: {install.blocked} Open{" "}
            <a href="https://command.desktopmachineshop.com">https://command.desktopmachineshop.com</a> and check Chrome shows a padlock.
          </p>
        ) : install.canInstall ? (
          <>
            <p className="small muted">Install Command Centre as an app: its own icon in your app drawer, full screen, no browser bar.</p>
            <button type="button" className="primary" onClick={() => void install.install()}>
              <Icon name="install" /> Install app
            </button>
          </>
        ) : (
          <p className="small muted">
            To install: on Android, open the Chrome menu (⋮) and tap <strong>Install app</strong>. On iPhone, tap Share, then{" "}
            <strong>Add to Home Screen</strong>. On a PC, use the install icon in the address bar.
          </p>
        )}
      </div>
      <div className="card">
        <div className="card-head">
          <Icon name="bell" />
          <h3>Notifications</h3>
        </div>
        <p className="muted small">Get a push notification when an action needs your approval.</p>
        <button className="primary" onClick={enablePush}>
          Enable on this device
        </button>
        {status && <p className="small">{status}</p>}
      </div>
      <Account api={api} />
      <div className="card">
        <div className="card-head">
          <Icon name="logout" />
          <h3>Sign out</h3>
        </div>
        <p className="muted small">Signs this device out. Other devices stay signed in.</p>
        <button className="danger-text" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </section>
  );
}
