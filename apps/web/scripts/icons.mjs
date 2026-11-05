// Renders the PWA's PNG icons from public/icon.svg (and the nav glyphs for shortcuts) with
// headless Chromium. Android only mints an installed app (WebAPK) from PNG icons, so these
// are committed; rerun after changing the logo:
//   CC_CHROMIUM_BIN=/path/to/chromium node scripts/icons.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "public", "icons");
mkdirSync(out, { recursive: true });

const logo = readFileSync(join(root, "public", "icon.svg"), "utf8");
const BRAND_BG = "#0f172a";
const ACCENT = "#2c5bd1";

// Same paths as src/icons.tsx, drawn on a 24px grid.
const GLYPHS = {
  approvals: "M9 12l2 2 4-4M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z",
  chat: "M4 5h16v11H9l-5 4z M8 9.5h8 M8 12.5h5",
  today: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4 M8 14h3v3H8z",
  converse: "M4 10v4 M8 7v10 M12 4v16 M16 7v10 M20 10v4",
};

/** [file, size, html body]. Transparent page so the rounded corners stay transparent. */
const jobs = [
  ["icon-192.png", 192, logo],
  ["icon-512.png", 512, logo],
  ["apple-touch-icon.png", 180, logo.replace('rx="96"', 'rx="0"')],
  // Maskable: full-bleed background, the mark inside the central 80% safe zone.
  [
    "maskable-512.png",
    512,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BRAND_BG}"/>` +
      `<g transform="translate(256 256) scale(0.72) translate(-256 -256)"><path d="M363.2 166 A140 140 0 1 0 363.2 346" fill="none" stroke="#2dd4bf" stroke-width="50"/><circle cx="256" cy="256" r="45" fill="#2dd4bf"/></g></svg>`,
  ],
  ...Object.entries(GLYPHS).map(([name, d]) => [
    `shortcut-${name}.png`,
    96,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${ACCENT}"/>` +
      `<g transform="translate(24 24) scale(2)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></g></svg>`,
  ]),
];

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_BIN || "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const [file, size, svg] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
  await page.screenshot({ path: join(out, file), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`${file} ${size}x${size}`);
}
await browser.close();
