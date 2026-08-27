/**
 * gen-schema.mjs — emits schema/recipe.schema.json from the zod source of
 * truth so external editors/skills can edit recipes without importing artai.
 * Runs through the built dist to stay single-sourced.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(join(pkgDir, "dist/core.js"));

const jsonSchema = mod.recipeJsonSchema();
mkdirSync(join(pkgDir, "schema"), { recursive: true });
writeFileSync(
  join(pkgDir, "schema/recipe.schema.json"),
  JSON.stringify(jsonSchema, null, 2) + "\n",
);
console.log("artai: schema/recipe.schema.json written ✔");
