#!/usr/bin/env node
// Bundles the worker into one CommonJS file (dist/cc-worker.cjs). With --sea it
// also builds a Node single-executable (dist/cc-worker[.exe]) and copies it to
// the desktop app's sidecar folder as binaries/cc-worker-<target triple>[.exe].
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const sidecarDir = join(root, "..", "desktop", "src-tauri", "binaries");
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: join(dist, "cc-worker.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs", // Node 22 SEA runs a CommonJS main script
  legalComments: "none",
  // playwright-core ships its own driver files and can't be bundled: video.capture loads it at
  // runtime and reports a clear error when it's missing (see docs/VIDEO.md, "Worker setup").
  external: ["playwright-core"],
  logLevel: "info",
});

if (process.argv.includes("--sea")) {
  const exe = process.platform === "win32" ? ".exe" : "";
  const blob = join(dist, "sea-prep.blob");
  const out = join(dist, `cc-worker${exe}`);
  writeFileSync(
    join(dist, "sea-config.json"),
    JSON.stringify({ main: join(dist, "cc-worker.cjs"), output: blob, disableExperimentalSEAWarning: true }),
  );
  execFileSync(process.execPath, ["--experimental-sea-config", join(dist, "sea-config.json")], { stdio: "inherit" });
  copyFileSync(process.execPath, out);
  chmodSync(out, 0o755);
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", out], { stdio: "inherit" });

  const postject = join(root, "node_modules", "postject", "dist", "cli.js");
  const args = [postject, out, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  execFileSync(process.execPath, args, { stdio: "inherit" });
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", out], { stdio: "inherit" });

  const triple = targetTriple();
  mkdirSync(sidecarDir, { recursive: true });
  copyFileSync(out, join(sidecarDir, `cc-worker-${triple}${exe}`));
  console.log(`sidecar: ${join(sidecarDir, `cc-worker-${triple}${exe}`)}`);
}

/** The Rust host triple Tauri expects in sidecar file names. */
function targetTriple() {
  try {
    return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
  } catch {
    const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch] ?? process.arch;
    return { win32: `${arch}-pc-windows-msvc`, darwin: `${arch}-apple-darwin`, linux: `${arch}-unknown-linux-gnu` }[process.platform];
  }
}
