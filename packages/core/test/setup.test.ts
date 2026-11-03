import { describe, expect, it } from "vitest";
import { parseInbound, roleStatus, SETUP_ROLES, wingetPackages } from "../src";

const media = SETUP_ROLES.find((r) => r.id === "media")!;
const claude = SETUP_ROLES.find((r) => r.id === "claude")!;

describe("device roles", () => {
  it("shows what a Windows computer has, and what one click would install", () => {
    const node = { capabilities: ["ffmpeg" as const], setup: { platform: "win32", installer: "winget" as const, installed: ["ffmpeg" as const] } };
    const status = roleStatus(media, node);
    expect(Object.fromEntries(status.components.map((c) => [c.component.id, c.state]))).toEqual({
      ffmpeg: "installed",
      browser: "missing",
      gpu: "unavailable",
      davinci: "manual",
    });
    expect(status.installable).toEqual(["browser"]);
    expect(status.ready).toBe(false);
    expect(roleStatus(claude, node).installable).toEqual(["git", "claude-code"]);
  });

  it("counts a role ready without its optional parts", () => {
    const node = { capabilities: [], setup: { platform: "win32", installer: "winget" as const, installed: ["ffmpeg" as const, "browser" as const] } };
    expect(roleStatus(media, node)).toMatchObject({ ready: true, installable: [] });
  });

  it("offers nothing to install without winget, and falls back to capabilities for older workers", () => {
    const mac = { capabilities: [], setup: { platform: "darwin", installer: null, installed: [] } };
    expect(roleStatus(media, mac).installable).toEqual([]);
    expect(roleStatus(media, mac).components.find((c) => c.component.id === "ffmpeg")?.state).toBe("unavailable");
    const old = { capabilities: ["claude-local" as const] };
    expect(roleStatus(claude, old).components.map((c) => c.state)).toEqual(["unknown", "installed"]);
  });

  it("maps only catalog components to winget packages", () => {
    expect(wingetPackages(["ffmpeg", "gpu", "davinci", "rm -rf /", "ffmpeg", "claude-code"])).toEqual([
      { component: "ffmpeg", id: "Gyan.FFmpeg" },
      { component: "claude-code", id: "Anthropic.ClaudeCode" },
    ]);
  });

  it("parses a worker's capability update", () => {
    const msg = parseInbound(JSON.stringify({ type: "worker.capabilities", capabilities: ["ffmpeg"], setup: { platform: "win32", installer: "winget", installed: ["ffmpeg"] } }));
    expect(msg).toMatchObject({ type: "worker.capabilities", capabilities: ["ffmpeg"] });
  });
});
