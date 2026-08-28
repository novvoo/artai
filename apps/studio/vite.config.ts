import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioDir = dirname(fileURLToPath(import.meta.url));
const libSrc = join(studioDir, "../../packages/artai/src");

/**
 * BYOK studio pages fetch model APIs straight from the browser, but some
 * gateways emit a malformed `Access-Control-Allow-Origin` (e.g.
 * `http://localhost:5173, *` — two values) that browsers must reject.
 *
 * This middleware is a same-origin passthrough: the page calls
 * `/artai-proxy?target=<encoded url>` and the dev server relays the request,
 * so the browser's CORS machinery never sees the upstream headers at all.
 * The body is piped through rather than buffered, keeping SSE streaming live.
 */
const corsPassthrough: Plugin = {
  name: "artai-cors-passthrough",
  configureServer(server) {
    server.middlewares.use("/artai-proxy", (req, res) => {
      void (async () => {
        const target =
          new URL(req.url ?? "/", "http://proxy.local").searchParams.get("target");
        if (!target || !/^https?:\/\//i.test(target)) {
          res.statusCode = 400;
          res.end("artai-proxy: ?target=<encoded http(s) url> required");
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        try {
          const hopHeaders =
            /^(host|connection|content-length|origin|referer|user-agent)$/i;
          const upstream = await fetch(target, {
            method: req.method,
            headers: Object.fromEntries(
              Object.entries(req.headers)
                .filter(([k]) => !hopHeaders.test(k))
                .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
            ),
            body: /^(GET|HEAD)$/i.test(req.method ?? "")
              ? undefined
              : Buffer.concat(chunks),
          });
          res.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            // these describe the upstream socket, not our re-piped stream
            if (!/^(content-length|content-encoding|transfer-encoding|connection)$/i.test(key))
              res.setHeader(key, value);
          });
          if (upstream.body) {
            const reader = upstream.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
          }
          res.end();
        } catch (err) {
          if (!res.headersSent) res.statusCode = 502;
          res.end(`artai-proxy upstream error: ${String(err)}`);
        }
      })();
    });
  },
};

/**
 * Dev-time aliases point straight at the library's TypeScript SOURCE so that
 * edits inside packages/artai hot-reload in Studio without needing
 * `npm run build -w packages/artai` first — kills the whole class of
 * "stale dist" bugs at their root.
 *
 * The published package.json exports still target dist/ for npm consumers;
 * only workspace development bypasses it via these aliases.
 */
export default defineConfig({
  plugins: [svelte(), corsPassthrough],
  resolve: {
    alias: [
      { find: /^artai\/agent$/, replacement: join(libSrc, "agent/index.ts") },
      { find: /^artai\/render$/, replacement: join(libSrc, "render/index.ts") },
      { find: /^artai\/core$/, replacement: join(libSrc, "core/index.ts") },
      { find: /^artai$/, replacement: join(libSrc, "index.ts") },
    ],
  },
  optimizeDeps: {
    // @ffmpeg/* is dynamically imported on first video export; without this
    // the dev server discovers it mid-session and the import 404s until a
    // restart (vite re-optimizes behind a stale hash)
    include: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
