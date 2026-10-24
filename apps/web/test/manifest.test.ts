import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Android only installs the PWA as a real app (WebAPK) with PNG icons; these checks keep
// the manifest installable as icons and pages change.
const pub = (p: string) => new URL(`../public${p}`, import.meta.url);
const manifest = JSON.parse(readFileSync(pub("/manifest.webmanifest"), "utf8"));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const b = readFileSync(pub(path));
  expect(b.subarray(1, 4).toString()).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("web app manifest", () => {
  it("has the fields Chrome needs to install it", () => {
    expect(manifest).toMatchObject({ id: "/", scope: "/", display: "standalone" });
    expect(manifest.start_url).toMatch(/^\//);
    expect(manifest.name && manifest.short_name).toBeTruthy();
  });

  it("has 192 and 512 PNG icons whose real size matches, plus a separate maskable icon", () => {
    const pngs = manifest.icons.filter((i: { type: string }) => i.type === "image/png");
    for (const size of ["192x192", "512x512"]) {
      const icon = pngs.find((i: { sizes: string; purpose: string }) => i.sizes === size && i.purpose === "any");
      expect(icon, `${size} any icon`).toBeTruthy();
    }
    expect(pngs.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of pngs) expect(pngSize(icon.src).join("x")).toBe(icon.sizes);
  });

  it("points at files that exist, with the declared sizes", () => {
    for (const s of manifest.shortcuts) {
      expect(s.url).toMatch(/^\/#\//);
      for (const icon of s.icons) expect(pngSize(icon.src).join("x")).toBe(icon.sizes);
    }
    for (const shot of manifest.screenshots) {
      expect(existsSync(pub(shot.src))).toBe(true);
      expect(pngSize(shot.src).join("x")).toBe(shot.sizes);
      expect(["narrow", "wide"]).toContain(shot.form_factor);
    }
  });
});
