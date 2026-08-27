/**
 * build-lib.mjs — esbuild bundling for the three export entries + d.ts via tsc.
 * esm only for v0; cjs added at publishing time if a consumer demands it.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pkgDir, "src");

mkdirSync(join(pkgDir, "dist"), { recursive: true });

const entries = {
  index: join(src, "index.ts"),
  core: join(src, "core/index.ts"),
  agent: join(src, "agent/index.ts"),
  render: join(src, "render/index.ts"),
};

await Promise.all(
  Object.entries(entries).map(([name, entry]) =>
    build({
      entryPoints: [entry],
      outfile: join(pkgDir, `dist/${name}.js`),
      bundle: true,
      format: "esm",
      platform: "neutral",
      target: "es2022",
      external: ["zod", "p5.brush"], // honest dependency graph (peer is optional)
      sourcemap: true,
      minify: false,
      legalComments: "inline",
      banner: { js: "// artai — deterministic minimal-zine poster engine" },
    }),
  ),
);

// declaration emit
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: pkgDir,
  stdio: "inherit",
});

console.log("artai: dist built ✔");
