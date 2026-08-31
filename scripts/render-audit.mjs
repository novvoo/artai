/**
 * render-audit.mjs — the authored⇒deposited regression smoke.
 *
 * Renders every pinned fixture graph in a real browser and asserts every
 * authored shape deposits visible pixels (verifyGraphDeposition). This is
 * the net that catches painter/schema drift of the "shape drawn in JSON,
 * absent on canvas" class — the 2-point stroke drop, the grain-scale bug,
 * invisible washes — none of which any JSON-level rule can see.
 *
 * Usage:  node scripts/render-audit.mjs [devServerUrl]
 * Exits non-zero listing any invisible shapes.
 */
import { chromium } from "playwright-chromium";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] ?? "http://localhost:5173";

const fixtures = ["station-clock-graph.json"];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "load", timeout: 60000 });

let failed = false;
for (const f of fixtures) {
  const graph = JSON.parse(
    readFileSync(join(root, "packages/artai/test/fixtures", f), "utf8"));
  const audit = await page.evaluate(async (g) => {
    const artai = await import(
      "/@fs/Users/jingslunt/aidesign/artai/packages/artai/dist/index.js");
    return artai.verifyGraphDeposition(g, 627262493);
  }, graph);
  const invisible = audit.invisible;
  console.log(
    `${f}: ${audit.reports.length} shapes audited, ` +
    `${invisible.length} invisible`);
  for (const r of invisible) {
    failed = true;
    console.log(
      `  ✗ ${r.layerId}#${r.shapeIndex} (${r.type}) deposited Δ${r.deposited} ` +
      `bbox=${JSON.stringify(r.bbox)}`);
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
