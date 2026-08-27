/**
 * dev.mjs — one-command developer loop:
 *   clear vite cache → build artai → start pi-bridge → start Studio (vite)
 *
 * Both processes are spawned as children; Ctrl+C tears down the whole tree.
 * If something is already serving the bridge port (health check passes),
 * the bridge spawn is skipped instead of crashing with EADDRINUSE.
 */
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE_PORT = Number(process.env.PI_BRIDGE_PORT ?? 8787);

const log = (tag, line) => process.stdout.write(`\x1b[2m[${tag}]\x1b[0m ${line}`);
const errLog = (tag, line) => process.stderr.write(`\x1b[2m[${tag}]\x1b[0m ${line}`);

async function bridgeAlreadyUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 700);
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/* step 1–2: cache clean + lib build (previous dev chain behaviour) */
execFileSync("node", [join(root, "scripts/clear-vite-cache.mjs")], { cwd: root, stdio: "inherit" });
try {
  execFileSync("npm", ["run", "build", "-w", "packages/artai"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
} catch (e) {
  errLog("dev", "artai 构建失败 —— 继续启动（Studio 别名直读 src）");
}

const children = [];

if (await bridgeAlreadyUp()) {
  log("bridge", `端口 ${BRIDGE_PORT} 已有 pi-bridge 在运行，跳过启动\n`);
} else {
  const bridge = spawn("node", [join(root, "apps/pi-bridge/server.mjs"), "--port", String(BRIDGE_PORT)],
    { cwd: root, env: process.env });
  bridge.stdout.on("data", (d) => log("bridge", d));
  bridge.stderr.on("data", (d) => errLog("bridge", d));
  bridge.on("exit", (code) => errLog("bridge", `exited (${code})\n`));
  children.push(bridge);
}

const studio = spawn("npm", ["run", "dev", "-w", "apps/studio"], {
  cwd: root,
  env: process.env,
  shell: process.platform === "win32",
});
studio.stdout.on("data", (d) => log("studio", d));
studio.stderr.on("data", (d) => errLog("studio", d));
children.push(studio);

let shuttingDown = false;
function shutdown(signal = "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  log("dev", `收到退出信号 (${signal})，正在关闭全部子进程…`);
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
  }
  // hard-exit fallback in case vite holds the tty
  setTimeout(() => process.exit(0), 800);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
studio.on("exit", (code) => {
  log("studio", `exited (${code})`);
  shutdown("studio-exit");
});

log("dev", "pi-bridge 与 Studio 已启动 —— 模型设置选 pi-node 预设即可。\n");
