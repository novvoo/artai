#!/usr/bin/env node
/**
 * artai CLI — doctor / schema / make / batch.
 * Imports the built dist; prints a friendly hint when the library isn't built yet.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function loadLib() {
  const entry = join(pkgDir, "dist/index.js");
  if (!existsSync(entry)) {
    console.error("artai: library not built yet. Run `npm run build -w packages/artai` first.");
    process.exit(1);
  }
  return import(entry);
}

const [cmd, ...rest] = process.argv.slice(2);
const argOf = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function main() {
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`artai — deterministic minimal-zine poster engine

Usage:
  artai doctor                       environment / capability report
  artai schema                       print recipe JSON Schema
  artai make "<theme>" [--seed n] [--backend prompt|render|hybrid]
  artai batch "<theme>" --count n [--seed base]
`);
    return;
  }

  if (cmd === "doctor") {
    console.log(JSON.stringify({
      node: process.version,
      enginesTarget: ">=20",
      webgl2: typeof globalThis.WebGL2RenderingContext !== "undefined",
      offscreenCanvas: typeof globalThis.OffscreenCanvas !== "undefined",
      libraryBuilt: existsSync(join(pkgDir, "dist/index.js")),
      backends: { render: "needs a WebGL2 host (browser / headless chromium)", prompt: "works everywhere" },
      llmTransport: "heuristic (default) · pi-node via @earendil-works/pi-coding-agent (optional)",
      nativeBinaries: "none required",
    }, null, 2));
    return;
  }

  const lib = await loadLib();

  if (cmd === "schema") {
    console.log(JSON.stringify(lib.recipeJsonSchema(), null, 2));
    return;
  }

  if (cmd === "make") {
    const theme = rest[0];
    if (!theme || theme.startsWith("--")) {
      console.error('usage: artai make "<theme>" [--seed n]');
      process.exit(1);
    }
    const seed = Number(argOf("--seed") ?? 42);
    const envelope = await lib.poster(theme, { seed });
    printEnvelope(envelope);
    return;
  }

  if (cmd === "batch") {
    const theme = rest[0];
    const count = Number(argOf("--count") ?? 4);
    const seed = Number(argOf("--seed") ?? 7);
    const draft = await lib.getDefaultProvider().parse({ theme });
    const { envelopes, batchViolations } = lib.realizeBatch(draft, count, { seed });
    envelopes.forEach((env, i) => {
      console.log(`\n${"═".repeat(60)}\n[${i + 1}/${count}] seed=${env.meta.seedUsed} ${env.gate.pass ? "✓" : "⚠ degraded"} family=${env.recipe.layout.family}`);
      printEnvelope(env, { quietBanner: true });
    });
    if (batchViolations.length) {
      console.warn(`\nbatch violations after repair (${batchViolations.length}):`);
      for (const v of batchViolations) console.warn(`  · ${v.code}: ${v.message}`);
    }
    return;
  }

  console.error(`unknown command: ${cmd} (try \`artai help\`)`);
  process.exit(1);
}

function printEnvelope(env, opts = {}) {
  const { gate, meta, recipe } = env;
  console.log(
    [
      `theme     : ${recipe.metaphor.relation}`,
      `recipe    : [${recipe.layout.family} / ${recipe.focal.form} / ${recipe.type.mode} / ${recipe.color.name} ${recipe.color.hue} via ${recipe.color.carrier} / ${recipe.texture.mode} / ${recipe.mood}]`,
      `measured  : air=${gate.measured.negativeSpace} cluster=${gate.measured.clusterShare} accent≈${gate.measured.accentShareEstimate}`,
      `meta      : seed=${meta.seedUsed} attempts=${meta.attempts}${meta.degraded ? " DEGRADED" : ""} intent=${meta.intentSource} in ${meta.durationMs}ms`,
      "",
      env.prompt,
      "",
    ].join("\n"),
  );
  void opts;
}

main().catch((err) => {
  console.error("artai:", err.message);
  process.exit(1);
});
void require;
