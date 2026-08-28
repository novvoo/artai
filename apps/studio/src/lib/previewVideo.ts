/**
 * previewVideo.ts — export the layer-by-layer reveal of the current
 * composition graph as an MP4, via ffmpeg.wasm.
 *
 * Pipeline: draw reveal frames deterministically on an offscreen canvas
 * (same paintGraphOntoCanvas engine as the live preview) → JPEG sequence
 * into ffmpeg's virtual FS → libx264 encode → Blob download.
 *
 * The single-threaded @ffmpeg/core build is used (no SharedArrayBuffer /
 * COOP-COEP headers required) and ships from node_modules via Vite ?url
 * asset imports — fully offline, no CDN round-trip.
 */
import coreJsUrl from "@ffmpeg/core?url";
import coreWasmUrl from "@ffmpeg/core/wasm?url";

export interface PreviewVideoOptions {
  /** composition graph (engine.graph) */
  graph: {
    lightDeg: number;
    layers: Array<Record<string, unknown>>;
  };
  /** scene IR — the typography/chrome overlay source (final frame = final PNG) */
  ir: Record<string, unknown>;
  /** poster canvas dimensions (IR canvas) */
  width: number;
  height: number;
  seed: number;
  /** locked palette handed to the renderer (engine.graph.paletteLocked) */
  paletteHexes?: string[];
  /** progress reporter: stage label + 0..1 fraction */
  onProgress?: (stage: string, pct: number) => void;
}

const FPS = 30;
const FRAMES_PER_LAYER = 9; // ≈0.3s per layer reveal
const HOLD_FRAMES = 45;     // 1.5s hold on the finished poster

export async function exportPreviewVideo(
  opts: PreviewVideoOptions,
): Promise<Blob> {
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const { fetchFile } = await import("@ffmpeg/util");
  const { paintGraphOntoCanvas } = await import("artai/render");

  const report = opts.onProgress ?? (() => {});
  const layers = [...opts.graph.layers].sort(
    (a: any, b: any) => Number(a.depth ?? 0) - Number(b.depth ?? 0),
  );
  // full poster resolution — the video is a 1:1 recording of the preview.
  // libx264 + yuv420p require even dimensions; posters are 1200×2000 (even)
  // but guard anyway for arbitrary canvas sizes.
  const W = Math.round(opts.width) - (Math.round(opts.width) % 2);
  const H = Math.round(opts.height) - (Math.round(opts.height) % 2);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas2D unavailable in this environment");

  const frameCount = layers.length * FRAMES_PER_LAYER + HOLD_FRAMES;

  // ── 1. render the reveal frames ─────────────────────────────────────────
  const blobs: Blob[] = [];
  for (let f = 0; f < frameCount; f++) {
    const reveal = Math.min(layers.length, Math.floor(f / FRAMES_PER_LAYER) + 1);
    ctx.clearRect(0, 0, W, H);
    paintGraphOntoCanvas(
      ctx,
      {
        lightDeg: opts.graph.lightDeg,
        layers: layers.slice(0, reveal),
        paletteLocked: opts.paletteHexes ?? [],
      } as any,
      opts.ir as any,
      { width: W, height: H, seed: opts.seed >>> 0 },
    );
    blobs.push(await new Promise<Blob>((res) =>
      canvas.toBlob((b) => res(b!), "image/jpeg", 0.85),
    ));
    if (f % 15 === 0) report("渲染帧", (f / frameCount) * 0.5);
  }

  // ── 2. load the wasm core (local assets — works offline) ───────────────
  report("加载 ffmpeg.wasm", 0.5);
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({ coreURL: coreJsUrl, wasmURL: coreWasmUrl });
  ffmpeg.on("progress", ({ progress }: { progress: number }) =>
    report("编码 MP4", 0.6 + Math.max(0, Math.min(1, progress)) * 0.4));

  // ── 3. frames in → mp4 out ──────────────────────────────────────────────
  const name = (i: number): string => `f${String(i).padStart(4, "0")}.jpg`;
  for (let i = 0; i < blobs.length; i++) {
    await ffmpeg.writeFile(name(i), await fetchFile(blobs[i]));
  }
  await ffmpeg.exec([
    "-framerate", String(FPS),
    "-i", "f%04d.jpg",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "preview.mp4",
  ]);
  const out = await ffmpeg.readFile("preview.mp4");
  report("完成", 1);

  const bytes = out instanceof Uint8Array ? out : new TextEncoder().encode(String(out));
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "video/mp4" });

  // best-effort FS cleanup — the core instance is discarded after this run
  try {
    for (let i = 0; i < blobs.length; i++) await ffmpeg.deleteFile(name(i));
    await ffmpeg.deleteFile("preview.mp4");
  } catch { /* instance teardown handles it */ }

  return blob;
}
