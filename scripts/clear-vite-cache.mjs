import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const p of [
  join(root, "apps/studio/node_modules/.vite"),
  join(root, "node_modules/.vite"),
]) {
  try { rmSync(p, { recursive: true, force: true }); } catch {}
}
console.log("vite caches cleared");
