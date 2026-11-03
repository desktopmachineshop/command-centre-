import { type ComponentState, type Job, roleStatus, SETUP_COMPONENTS, SETUP_ROLES, type SetupRoleId, type WorkerNode } from "@cc/core";
import { useState } from "react";
import type { Api } from "./api";
import { Icon } from "./icons";

const STATE_LABEL: Record<ComponentState, string> = {
  installed: "Installed",
  missing: "Not installed",
  manual: "Install yourself",
  unavailable: "Not installed",
  unknown: "Unknown",
};

const stateLabel = (state: ComponentState, hardware: boolean) => (state === "unavailable" && hardware ? "Not available" : STATE_LABEL[state]);

const isActive = (j: Job) => j.status === "queued" || j.status === "assigned" || j.status === "running";

const jobError = (j: Job): string =>
  j.result && typeof j.result === "object" && typeof (j.result as { error?: unknown }).error === "string"
    ? (j.result as { error: string }).error
    : "The install failed without a message.";

/**
 * Under each computer on the Devices page: every role (media production, local Claude Code),
 * what it needs with a tick or a cross, and a one-click Install for what's missing. The computer
 * installs it with winget (a setup.install job only it takes), then reports back, so the ticks
 * update by themselves.
 */
export function DeviceRoles({ api, node, jobs }: { api: Api; node: WorkerNode; jobs: Job[] }) {
  const [starting, setStarting] = useState<SetupRoleId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setupJobs = jobs.filter((j) => j.kind === "setup.install" && j.targetNodeId === node.id);
  const active = setupJobs.find(isActive);
  // The newest finished install, to show its error until the next one.
  const last = setupJobs.filter((j) => !isActive(j)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const activeRole = active ? ((active.payload as { role?: string }).role ?? null) : null;

  const install = async (role: SetupRoleId) => {
    setStarting(role);
    setError(null);
    try {
      await api.installRole(node.id, role); // progress arrives as job.updated
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(null);
    }
  };

  const canInstall = !!node.setup?.installer;
  const note = !node.setup
    ? "Update the desktop app on this computer to install from here."
    : !canInstall
      ? node.setup.platform === "win32"
        ? "This computer can't install by itself: get App Installer (winget) from the Microsoft Store."
        : "Installing from here works on Windows. Install what's missing on this computer yourself."
      : !node.online
        ? "Open the desktop app on this computer to install."
        : null;

  return (
    <div className="device-roles">
      {SETUP_ROLES.map((role) => {
        const status = roleStatus(role, node);
        const names = status.installable.map((id) => SETUP_COMPONENTS[id].label);
        const installingThis = !!active && activeRole === role.id;
        return (
          <section key={role.id} className="device-role" aria-label={`${role.label} on ${node.name}`}>
            <div className="device-role-head">
              <div className="grow">
                <span className="device-role-title">{role.label}</span>
                <span className={`device-role-badge ${status.ready ? "ok" : ""}`}>{status.ready ? "Ready" : `${status.components.filter((c) => c.state !== "installed" && c.state !== "unknown" && !c.component.optional).length || "?"} missing`}</span>
              </div>
              {status.installable.length > 0 && canInstall && (
                <button
                  type="button"
                  className="small primary"
                  disabled={!node.online || !!active || starting !== null}
                  onClick={() => void install(role.id)}
                  title={`Installs ${names.join(", ")} on ${node.name}`}
                >
                  <Icon name="install" size={14} />{" "}
                  {installingThis ? "Installing…" : starting === role.id ? "Starting…" : `Install ${names.join(", ")}`}
                </button>
              )}
            </div>
            <ul className="device-role-items">
              {status.components.map(({ component, state }) => (
                <li key={component.id} className={`device-role-item ${state}`}>
                  <span className="device-role-mark" aria-hidden>
                    <Icon name={state === "installed" ? "check" : state === "unknown" ? "clock" : "x"} size={14} />
                  </span>
                  <span className="device-role-name">
                    {component.label}
                    {component.optional && <span className="muted"> (optional)</span>}
                  </span>
                  <span className="device-role-state">
                    {state === "manual" && component.install.kind === "manual" ? (
                      <a href={component.install.url} target="_blank" rel="noreferrer">
                        {STATE_LABEL[state]} <Icon name="external" size={12} />
                      </a>
                    ) : (
                      stateLabel(state, component.install.kind === "hardware")
                    )}
                  </span>
                  <span className="device-role-why muted">{component.why}</span>
                </li>
              ))}
            </ul>
            {installingThis && active && (
              <div className="progress" role="progressbar" aria-label={`Installing ${role.label}`} aria-valuenow={Math.round((active.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.max(4, Math.round((active.progress ?? 0) * 100))}%` }} />
              </div>
            )}
          </section>
        );
      })}
      {active && <p className="small muted">{node.online ? "Installing on the computer. Windows may ask there for permission to install." : "Waits until the computer is online."}</p>}
      {note && !active && <p className="small muted">{note}</p>}
      {error && <p className="error small">{error}</p>}
      {!active && last?.status === "failed" && <p className="error small device-role-error">{jobError(last)}</p>}
    </div>
  );
}
