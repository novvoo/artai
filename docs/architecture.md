# artai — Architecture

Engineering-grade JavaScript library for editorial poster generation: a theme goes in, either a deterministic p5.brush raster or an image-model prompt comes out — driven by the same versioned design artifact.

Source studies this document is grounded in:

- **`gc-minimal-zine-poster` v0.3.1** (MIT) — a *decision system*: routes requests, picks design axes, compiles prompts, applies a quality gate. No renderer; it terminates in prose for an image model.
- **`p5.brush` v2.2.2** (MIT) — a *rendering system*: natural media on WebGL2 (brushes, watercolor fills, scanline hatching, flow fields) via mask-composite rendering with dirty-rect blits. No decision layer.

artai's thesis: **promote the zine recipe from prose to a typed, versioned data structure; lower it through layout into a serializable Scene IR; fold that IR through pluggable backends.**

---

## 1. Goals and non-goals

| Goals | Non-goals |
|---|---|
| Theme → reproducible minimal-zine poster (raster or prompt) | General-purpose image editor or canvas library |
| Same Recipe → identical Plan/IR cross-platform | Byte-identical pixels across different GPUs/browsers (§11) |
| Print-resolution output, fast compositing | Competing with p5.brush primitives; forking it |
| Headless generation in CI (Chromium/SwiftShader) | AI image-gen as opt-in SUPPLEMENT (BYOK /images/generations client shipped) | Bundling our own image-generation model weights; mandating it for all users |
| Think-first: the model CHOOSES the visual event before any pixels | General-purpose image editor or canvas library |

The zine skill's own contract is inherited verbatim where stated: sparse vertical paper poster, one visual event, one high-chroma accent, batch variety rules, photo role/preservation semantics, "never report failed preservation as success."

---

## 2. System pipeline

```
 theme/article ──► ┌──────────────┐        THINK-FIRST: the model CHOOSES
 photo/references  │   INTENT     │        motifId from a 14-item palette,
                   │ metaphor,    │        mood, shortText — ALL mandatory.
                   │ motifId ←NEW │        Offline heuristic survives only in
                   │ mood, roles  │        library tests & eval fixtures.
                   └──────┬───────┘
                          │ IntentDraft {motifId, shortText,…}
                          ▼
                   ┌──────────────┐        ┌────────────────┐
                   │ VARIATION    │◄───────│ StylePackage   │ fixed / variable / residue
                   │ ENGINE       │ seed⊕  │ avoid list     │ content fingerprint folds
                   │ mood→hue pool│content │                │ into roll namespace
                   └──────┬───────┘        └────────────────┘
                          │ Recipe {schemaVersion}      ◄── typed + validated + serializable
                          │       includes {visual.motifId, detail}
                          ▼
                   ┌──────────────┐
                   │ LAYOUT       │  families × solver (monotone ink-budget)
                   │ SOLVER       │  budgets [.175,.42] enforced; breathing margins
                   └──────┬───────┘
                          │ Plan → boxes · baselines · measured air/cluster/accent
                          ▼
                   ┌──────────────┐
                   │ SCENE        │  ordered styled ops           ◄── serializable IR
                   │ COMPILER     │  guides · paper · backdrop(halo) · panelShadow
                   │              │  · fill/hatch · STROKES(flow-field loops)
                   │              │  · MOTIF(single-silhouette) · text(+microtext)
                   │              │  · chips(orbital) · marks · frame · postpress
                   └──────┬───────┘
              ┌───────────┴────────────┐
              ▼                        ▼
   ┌────────────────────────┐  ┌────────────────────┐
   │ RENDER BACKEND         │  │ PROMPT BACKEND     │
   │ dual rasterizer:       │  │ fold(IR → 4-para)  │
   │  · p5.brush webgl2     │  │ + full-spec (~30   │
   │    origin = top-left ✓ │  │  labeled sections) │
   │    flowfield edges     │  │ + negatives grouped│
   │    stamped strokeset   │  │                    │
   │  · canvas-2d fallback  │  │ third tier: AI     │
   │  ⇄ shared overlay for  │  │ image-gen opt-in   │
   │    type/marks/chrome   │  │ supplement (AD-15) │
   │ out: PNG+meta.renderer │  │ out: prompt string │
   └─────────┬──────────────┘  └─────────┬──────────┘
             ▼                           ▼
   ┌─────────────────────────────────────────────┐
   │ GATE                                        │
   │ core checks (Plan/IR math)                  │
   │ + pixel sampling (render env only)          │
   │ fail ⇒ bounded repair loop ⇒ honest envelope│
   │ NO silent degradation at ANY stage          │
   └─────────────────────────────────────────────┘
```

*Tooling surface: the entire chain above runs with **zero system-native binaries** — image decode, PNG/WebP encode, downscaling, and even the future PDF and animation paths stay inside the JS/browser platform (§19.1).*

Dependency direction is strictly one-way. Both backends are pure folds over the same IR — neither reads upstream stages directly. That symmetry is what later allows an SVG/plotter/PDF exporter without touching anything else.

---

## 3. The layering rule (enforced, not aspirational)

```
artai/
├── core/                    ← published subpath "artai/core"
│   types/      domain types, zod schemas, JSON-Schema export, migrations
│   intent/     parse.js · metaphor.js          (may be LLM-assisted; optional)
│   recipe/     variation.js · constraints.js · motifs.ts (strict 14-item palette + staging copy) · styles loader
│   layout/     families/ · solver.js · measure.js
│   scene/      compile.js · ops.js             (the IR)
│   prompt/     compile.js                      (4-paragraph shape)
│   gate/       checks-core.js                  (pure math checks)
│   ZERO runtime dependencies. ZERO DOM/WebGL/text API calls.
│   Runs in Node ≥20, workers, edge runtimes.
│
├── render/                  ← published subpath "artai/render" (root import)
    pipeline.js   driver: pick backend, run repair loop, emit envelope
    raster-p5.js  primary fold(IR) → p5.brush standalone calls
                  (field/wiggle activated; per-treatment rim brushes)
    raster-canvas.js  deterministic Canvas-2D fallback (pixel-diff reference)
    overlay.js    shared crisp chrome: text · marks · motif · grain —
                  identical output on both rasterizers
    fonts/        load + cache OFL woff2 subsets (opentype path ⏳)
    gate/         checks-pixel.js               (downsampled canvas sampling)
    Depends on: core + peer p5.brush ^2.x (optional; canvas path needs none).
│
└── agent/                   ← published subpath "artai/agent"
    heuristic.ts  rule-based IntentProvider/StyleAnalyzer ported from the
                  skill's own classification tables — offline default
    pi.ts         @earendil-works/pi-coding-agent adapter (lazy optionalPeer,
                  exact-pinned; structured-output + fallback contract)
    session.ts    ModelRuntime.create() → createAgentSession() plumbing;
                  built-in tools disabled, in-memory sessions only
    Depends on: core only (+ dynamic-import pi-coding-agent when the Pi tier is constructed).
```

**Enforcement mechanisms**, because a rule nobody enforces decays:

- `package.json` `"exports"` splits `./core`; `core` marked side-effect-free → bundlers tree-shake and headless consumers never pull GL code.
- ESLint `import/no-restricted-paths` forbids `core/** → render/**`, and a CI grep gate fails on `document`/`window`/WebGL identifiers inside `src/core/**`.
- `core` dependency audit: lockfile-level check that `artai/core`'s graph contains only itself + `zod`.

This split is the single most consequential engineering decision: the entire decision stack — recipe, layout, IR, prompt, core gate checks, evals — is testable and runnable anywhere, including the Prompt-only path on a server with no GPU.

---

## 4. Repository layout

npm-workspaces repo: one published library package, one app, shared root tooling. (The library itself remains a *single* package — the earlier rejection of splitting it into multiple packages stands; what's new is only the app/package workspace boundary.)

```
artai/
├── package.json                private root · workspaces{packages/*, apps/*}
├── tsconfig.base.json          strict, exactOptionalPropertyTypes, ES2022
├── eslint.config.js            boundaries: core↮render↮agent, browser-API ban in core
├── .changeset/                 release notes + semver automation
├── .github/workflows/
│   ├── ci.yml                  typecheck → lint → unit+property → build → visual(chromium+swiftshader)
│   ├── pages.yml               build lib + studio → GitHub Pages on main
│   └── release.yml             changesets npm publish (provenance/OIDC)
├── packages/
│   └── artai/                  THE library — everything in §3 lives here
│       ├── package.json        exports{., ./core, ./agent} · engines>=20 · peers p5.brush, pi(optional)
│       ├── vite.config.ts      lib build: esm+cjs+d.ts, per-subpath chunks
│       ├── vitest.config.ts    projects: node(unit+property+contracts) · chromium(visual)
│       ├── src/{core,render,agent,index.ts}
│       ├── schema/             generated recipe.schema.json
│       ├── assets/fonts/*.woff2  OFL subsets (Tier-2 committed outputs)
│       ├── test/{unit,property,goldens,visual,fixtures/zine-evals}
│       └── bin/artai.mjs       CLI entry (make/batch/doctor/schema)
├── apps/
│   └── studio/                 Svelte 5 SPA — see §18; consumes packages/artai directly
│       ├── src/{routes,components,lib}
│       └── vite.config.ts
├── examples/                   browser sketch · node script · hybrid photo demo
└── docs/
```

TypeScript strict throughout. Types are inferred from zod schemas (`z.infer`) so the runtime validator cannot drift from the static type. Build outputs esm + cjs + declarations; the `./core` entry builds its own chunk so downstream bundles skip opentype/p5.brush entirely when they only need prompts.

---

## 5. Grounded study — the zine skill's decision model

*(Unchanged from prior revision; summarized.)* The skill's structure is exactly what artai inherits:

- **Five modes** — Generate (default), Photo Input (subflow), Reference Analysis, Prompt-only, Analyze+Generate. In artai these become `intent.mode` values plus two concrete features: Reference Analysis output feeds StylePackages, Prompt-only is `poster({backend:"prompt"})`.
- **Photo roles & preservation** — edit target / reference image / supporting insert × High/Medium/Low. High means identity, proportions, markings, product geometry, silhouette, recognizable colors; strategy at High is "prefer an original-photo crop…over redrawing." artai executes this deterministically via image brushes (§10).
- **Quality gate** — ratio 3:5 default; 70–90% open paper; event at 8–25%; accent visible at thumbnail scale at 0.8–2.5% of canvas (or 15–35% of cluster); no unrequested maritime symbols/generic pictograms; no commercial/3D/neon drift; one regeneration allowed then honest reporting.
- **Variation discipline** — adjacent outputs differ in ≥3 axes (layout family, focal structure, typography distribution); batches of 4+ use ≥3 layout families; no repeated layout+focal pair adjacently; ≥60% of a batch carries hue via subject/block not dots.
- **Reference-analysis schema** — fixed system / variable system / sample residue / randomization block / avoid list / confidence = precisely a StylePackage.
- **Evals** — 8 pinned behaviors incl. known failure regressions (#8 non-maritime themes must not grow maritime symbols; #1 no default centered-photo+blue-dot). Mechanized in §15.

## 6. Grounded study — p5.brush's runtime model

Scope note: p5.brush contains **zero** LLM machinery (verified across its export surface). The only model-facing artifact it ships is documentation — a root-level `llms.txt` written for AI consumers. Where model calls actually live in artai: §11.

Key internals artai builds on (verified in source):

- **Host-hook adapter architecture.** Core never imports p5; adapters register `{ createColor, getAffineMatrix, usesRadians, notifyDraw }` (runtime), direct-mask hooks (renderer), and framebuffer/blend-pass hooks (compositor). Standalone adapter README: "reserved for the future non-p5 runtime adapter" — headless was always intended. Two shipped flavors: p5 build and standalone zero-dep WebGL2 build (`dist/brush.js`).
- **State machine + push/pop.** One `State` with six groups (`stroke, hatch, fill, wash, mass, field`); `push()/pop()` snapshots all six via a real stack. Drawing lands in offscreen masks; on color change `Mix.blend()` composites via blend shader; dirty rects feed scissored `blitFramebuffer` — fast at print DPI.
- **Brush registry.** `Map<name, {param, colors, buffers}>`. `add()` validates `type ∈ {default, custom, image, spray}` and normalizes params (`markerTip, noise∈[0,1], scatter/sharpness/grain` legacy aliases). **Pressure accepts `[start,end]`, `[start,mid,end]` U-curves, `(t)=>v`, or gaussian profiles** — the natural encoding for ghost-text and gray treatments.
- **Image brushes** — `type:"image"` + `loadImageTip`: bitmap becomes a stamped tip texture. This is the hook for photo fragments (§10).
- **GL path** — instanced point sprites (`a_position/a_radius/a_alpha`), soft-disc fragment shader with `smoothstep`+`fwidth`.
- **Fill/wash/hatch.** Watercolor fill = Tyler-Hobbs-style concentric polygon growth (`fillBleed(dir "out"|"in", angle)`, `fillTexture(texture,border,scatter)`), gaussian pools rebuilt on reseed via `_onSeed`. Wash = deliberately flat 2D-canvas path (no triangulation) — ideal for paper tones. Hatch = scanline-space intersection with reusable Float64 buffers, options `{rand, continuous, gradient}`, `hatchStyle(brush,color,weight)` override.
- **Determinism primitives.** Mulberry32 PRNG (SplitMix64-hashed seeds, string-friendly), dual streams rng/rng2, simplex-noise 2D, Box–Muller gaussians with cached second value + `_onSeed` pool rebuilds, pre-warmed 1440-entry sin/cos LUTs (0.25° quantization — table-based, hence cross-platform stable).
- **No text API.** Verified: no `text`/`font` exports exist. Typography is therefore artai's problem (§12).

Default brushes (11): `2B HB 2H cpencil pen rotring spray marker marker2 charcoal hatch_brush`. Default fields: `curved hand seabed waves zigzag`.

### 6.1 Distilled best practices → standing artai standards

p5.brush is treated here as the engineering exemplar the user intends it to be. Every practice below was verified in-repo; each becomes a standing standard, not admiration:

| Verified practice (evidence) | artai adoption |
|---|---|
| Host-hook inversion: core never imports p5; adapters register narrow hook sets (`setRuntime`, renderer, compositor); a dedicated `adapters/standalone/` stub dir signals headless as an intended destination | Adopted as the core/render split (AD-3), hardened beyond theirs with lint boundaries + CI browser-API ban |
| Same core, two entry files (`index.p5` / `index.standalone`) → **four dist artifacts** (umd+esm × 2 flavors) from one rollup config; exports map `.` + `./standalone`; `sideEffects:false`; `files:[dist,src]` whitelist | Mirrored as `.`, `./core`, `./agent` subpath map; separate chunking so core consumers never bundle GL or agent code |
| AI-first docs shipped as a repo artifact: root `llms.txt` opens with a fail-safe orientation table ("TWO BUILDS — READ THIS FIRST"), encodes the seeding contract and CDN snippets | artai CI generates `docs/llms.txt` at every release from zod schemas + golden examples; must open with pitfall-first tables (core-vs-render imports; determinism rows) |
| Release pipeline hard-gated (`publish-npm.yml`): tag↔version guard script → install → unit tests → build → Playwright browser smoke asserting zero page errors / canvas alive / WebGL2 context active (`ALLOWED_CONSOLE_ERRORS` kept deliberately empty as an invariant) → `npm publish --provenance` via OIDC trusted publisher | Adopt the whole chain verbatim; our smoke asserts pixelmatch goldens instead; **upgrade** their manual version bumps to changesets automation |
| Continuous deployment of docs/examples/tools: `deploy.yml` rebuilds the lib then publishes examples + interactive generators (brush-maker / flowfield-maker emit paste-ready config code) to GitHub Pages on every main push | Adopt for `examples/` now; the paste-ready-config generator pattern is direct inspiration for a future recipe-maker playground |
| Regression-page-per-bug culture, kept in-tree forever (`hatch_array_regression`, `instance_mode`, `multi_instance_async`, `wash_test`, `pastel_hatching_test`) plus a shared `visual_suite.js` harness and manual explorer pages (`fill_circle_explorer.html`) | Failing case → IR golden snapshot **and** a permanent visual gallery page per op group so contributors can eyeball paper/focal/type/marks knobs |
| Hot-path idioms throughout src: module-level scratch `Float64Array`s with growth caps, pre-warmed trig LUTs with %-free index math, cached second Box–Muller variate, gaussian pools rebuilt via `_onSeed` registry, incremental cumulative lengths instead of per-call reduce | Codified into CONTRIBUTING as a mandatory review checklist for anything under `render/ops`: no per-call allocations in hot loops; buffer pools module-level |
| Determinism engineered as a public feature and documented as such (string-seeded Mulberry32 via SplitMix64 finalizer, dual rng streams decorrelating `random()` vs `random(array)`, simplex reseeding — all visible in the llms.txt orientation table, not buried) | Lineage of AD-5; release notes must state seeding behavior changes as breaking-adjacent events |

Deliberate departures, stated to avoid cargo-culting: p5.brush ships plain JS — we take TS+zod because recipes cross serialize boundaries theirs never do; they report coverage without thresholds — we enforce thresholds on `core`; they bump versions by hand — changesets supersedes.

---

## 7. Vocabulary mapping (recipe axes → p5.brush calls)

| Zine concept | Realized as |
|---|---|
| Aged paper field | full-frame `wash(paperTone)` (flat 2D path) + `fillTexture` mottling pass |
| Torn-paper cutout | jittered `beginShape/vertex/endShape` → `Polygon` → watercolor `fill()` |
| Ink block, letterpress bleed | `polygon()` + `fillBleed(0.2,"out")` |
| Halftone degradation | `hatch(dist,angle,{rand,gradient})` + `hatchStyle("hatch_brush"\|"2B")` |
| Ghost text / archive microtext | glyph outlines → `Polygon`s → `set("HB",gray)` light strokes (see §12) |
| Organic wander | `field("seabed\|"hand"\|"curved"\|"waves"\|"zigzag")` + `flowLine()` |
| Hand annotation | `spline()` under `set("cpencil")` |
| Fine lines/dashes | `set("rotring")` + `line()` |
| Misregistration | `push(); translate(dx,dy); <redraw channel>; pop()` |
| Photo fragment | image brush composite inside reserved box + halftone treatment (§10) |
| Motif vignette (theme's ONE imageable event) | keyword scan (`core/recipe/motifs.ts`) → `motif` IR op → stroke-art paths painted by the shared overlay, accent-inked when the hue carrier is subject/block/cutout |
| Organic edge character | `field("hand"\|"curved"\|…)` + `wiggle()` bends per-treatment rim stubs (`flowLine`, marker2/spray/cpencil/charcoal by texture mode); hatch gains random `gradient`/`continuous` + conditional cross-pass |
| Replay | `seed() → noiseSeed() → refreshField()` chained from `Recipe.seed` |

Budget enforcement stays mathematical: `measure.js` proves negative space ∈ [70%,90%] and accent ∈ [0.8%,2.5%] *before rendering* (from Plan areas), and the pixel sampler re-verifies after rendering. The zine can only ask an image model for a 2% color share; artai guarantees it.

---

## 8. Recipe: typed, versioned, interopable

```ts
// types/recipe.ts (shape, abbreviated)
interface Recipe {
  schemaVersion: 1;
  seed: number;
  mode: "generate" | "photo-input" | "reference-informed";
  canvas:  { ratio: [number, number]; width: number; paperTone: PaperTone };
  attention: { negativeSpace: number; clusterScale: number; position: Position };
  metaphor: { subject: string; relation: string };
  focal:   { form: FocalForm; treatment: TextureMode };
  type:    { mode: TypeMode; text?: string; family: FontSetKey };
  color:   { hue: string; carrier: HueCarrier; canvasShare: number };
  texture: { mode: TextureMode; misregistration?: number };
  visual:  { motifId?: string };          // resolved from IntentDraft.motifHint
  detail:  number;                       // compute-density knob 1–6
  marks:   Mark[];                       // 0–3, constraint-checked
  mood:    Mood;                         // model-driven → hue pool
}
```

Decisions:

- **Single source of truth:** zod schemas → inferred TS types + `.parse()` at every boundary (user-supplied recipes, loaded files, plugin input).
- **JSON Schema export** (`schema/recipe.schema.json`, regenerated in CI): makes recipes editable by *external* tools — editors, the Codex/Claude skill ecosystem, notebook UIs — without importing artai.
- **Versioning:** `schemaVersion` integer; additive changes bump minor within same major-form; breaking changes ship a migration (`migrations/v1→v2`). Unknown-key policy: **strip + warn**, so older consumers survive forward-compatible extensions.
- **Recipes are data, always.** JSON-round-trippable; no functions, no class instances. Functions live in registries keyed by enum/string (families, forms, textures), which also keeps prompt-side serialization trivial.

## 9. Scene IR

Between Plan and backends sits a serializable intermediate representation — the folded result of compiling Recipe×Plan×StylePackage:

```jsonc
{
  "irVersion": 1,
  "canvas": { "width": 1200, "height": 2000 },
  "defs": { "p1": [[x,y],…] },
  "ops": [
    { "op": "paper",     "tone": "#F2ECDF", "mottle": [0.6,0.25], "fibers": true },
    { "op": "guides",    "at": [cx,cy], "cluster": [x,y,w,h], "color": "…" },
    { "op": "backdrop",  "kind": "disc", "box": […],
      "color": "#1b4fd8-wash", "alpha": 0.5, "rotation": 0 },
    { "op": "panelShadow","box": [x,y,w,h], "dx": –4, "dy": +8, "lightDeg": 145 },
    { "op": "fill",      "box": [x,y,w,h], "style": "inkblock",
      "bleed": [0.2,"out"], "color": "#D8412F", "paper": "#F2ECDF", "trim": true },
    { "op": "strokeset", "count": 4, "rMax": 200, "turns": 4,
      "field": "curved", "palette": ["#D8412F","#1B4FD8","#26241f"] },
    { "op": "motif",     "id": "envelope", "box": [x,y,w,h],
      "accent": "#D8412F", "accent2": "#1B4FD8",
      "paper": "#F2ECDF", "mode": "collage-fill",
      "lightDeg": 145, "edge": "cut" },
    { "op": "customMotif","spec": { caption, shapes[], clipSilhouette, shadow },
      "box": [x,y,w,h], "palette": {body,deep,wash,lift,line},
      "lightDeg": 145 },                             // LLM-authored (AD-16)
    { "op": "hatch",     "region": "p1", "dist": 6, "angle": 35,
      "options": {"rand":0.3}, "brush": "2B" },
    { "op": "text",      "str": "still here", "at": [x,y],
      "font": "typewriter", "sizePx": 36, "mode": "…",
      "ghost": 1.0, "paper": "#F2ECDF" },
    { "op": "microtext", "str": "NO.42 \u00b7 QUIET", "align": "right",
      "at": [x,y], "sizePx": 12, "paper": "#F2ECDF" },
    { "op": "chip",      "variant": "dotgrid", "at": [x,y], "color": "…" },
    { "op": "frame",     "inset": 16, "alpha": 0.55 },
    { "op": "mark",      "kind": "registration-mark", "at": [x,y] },
    { "op": "postpress", "mode": "risograph-grain",
      "misregistrationPx": 3, "grain": "<seed-ref>" }
  ]
}
```

The op set grew substantially behind `irVersion=1`: `guides` (construction axes), `backdrop` (depth-mass halo), `panelShadow` (per-panel cast shadow), `strokeset` (flow-field loop strokes), `customMotif` (LLM-authored shape spec replacing the builtin motif op when live generation succeeds), and `microtext` were all added. The set is expected to keep growing behind `irVersion`, same policy as Recipe.

Why an explicit IR rather than letting backends read the Plan:

1. **Backend symmetry.** Render folds ops to brush calls; prompt folds ops to paragraphs. Adding SVG export later = third fold, zero upstream change.
2. **Testing without GPU.** IR JSON goldens catch semantic regressions deterministically in plain Node; visual goldens then cover the last mile.
3. **Auditability.** A poster's full drawing intent is inspectable/diffable/hand-editable — matching the whole "recipes are data" philosophy all the way down.

Op set starts small (`paper, fill, hatch, strokePath, spline, text, marks group, photoFragment, transform-wrap`) and grows behind `irVersion`, same policy as Recipe.

## 10. Backends

**Render backend.** Fold = iterate ops, set p5.brush state, call primitives, inside `push()/pop()` per op-group (matching the library's own idiom). Uses the standalone zero-dep build for headless targets, the p5 build optionally for user sketches (same `Ops` handlers, different adapter — both already supported by p5.brush's hook architecture).

**Prompt backend.** Fold = map op semantics to the four-paragraph shape in the zine compiler's exact field order, substituting measured numbers ("Place one 14% visual cluster at lower-left third"), selecting relevant negatives from the compact bank (not the indiscriminate catalogue).

**Hybrid is first-class.** Zine rule: at High preservation prefer photo crop/redraw-free compositing. Deterministic execution: solver reserves the focal box → renderer draws frame + defects → `photoFragment` op pastes the crop through an image brush, degraded (halftone/xerox/misregistration) to belong to the printed world. Role mapping: edit-target→composite with invariant box+treatment recorded; supporting insert→same, smaller; reference-only→prompt backend driven by the extracted StylePackage.

## 11. LLM integration layer — `artai/agent` + `@earendil-works/pi-coding-agent`

**Premise corrected from the source.** p5.brush ships zero LLM machinery — its model-facing surface is documentation-shaped (the root `llms.txt`), and the zine skill's model calls depend entirely on whatever host agent executes it. artai therefore *owns* its model boundary instead of inheriting a weak one.

### 11.1 Ports in core, providers in shell

Core defines the interfaces (types only, no dependency); implementations are injected:

```ts
// core/types/ports.ts — consumed by recipe/, never implemented there
interface IntentProvider {
  parse(input: ParseInput): Promise<IntentDraft>;        // theme | article → thesis, metaphor pair, mood, suggested short text
  classifyRole(input: PhotoUtterance): Promise<PhotoRole>; // edit-target | reference-image | supporting-insert
}
interface StyleAnalyzer {
  analyze(files: ReferenceSet): Promise<StylePackageDraft>; // images → fixed/variable/residue + avoid list
}
```

THREE capabilities on ONE provider interface, all model-driven (think-first contract — no keyword table, no heuristic fallback in production):

- **`designMotif(input)` → CustomMotifSpec** (shipped) — model authors the shape geometry as a bounded SVG-path DSL informed by two canonical demo specs (envelope, fish) injected into the system prompt as few-shot examples. Strict zod validation + one bounded retry.
- **`refinePrompt(text)` → enriched prompt** (shipped) — second-round prompt polish preserving every measurable clause verbatim.

Transport implementations:
- **Browser provider (`agent/browser.ts`, shipped)** — BYOK fetch for Studio; tolerant coercion; 3-rung escalation ladder [2048/6048/6048] against thinking-model token burn; empty-reply diagnostics include finish_reason + token counts.
- **Heuristic stub (`test/fixtures/intent-stub.ts`)** — library-tier offline test double only; deleted from production exports.
- **Pi provider (`agent/pi.ts`, ⏳)** — wraps pi-coding-agent sessions for genuine language/vision work.

Wiring at the call site:

```ts
import { BrowserIntentProvider } from "artai/agent";
import type { IntentProvider } from "artai/core";
let provider: IntentProvider | null = new BrowserIntentProvider(cfg);
artai.setDefaultProvider(provider); // Studio always configures one

const draft = await provider.parse({ theme });    // LLM CHOOSES motifId
env = realize(draft, opts);                        // deterministic downstream
// if liveMotif enabled:
if (bp.id.startsWith("browser:") && liveMotif.on) {
  const spec = await bp.designMotif({...});        // LLM AUTHORS geometry
  applyCustomMotif(env.ir, spec);                  // replaces builtin op
}
env.prompt = await bp.refinePrompt(env.prompt);   // second-round polish
# 11.2 Why pi-coding-agent (verified facts)

`@earendil-works/pi-coding-agent@0.84.x` (MIT, Mario Zechner / earendil-works, very active — 42 releases May–Aug 2026):

- **Embedded SDK mode**: `ModelRuntime.create()` → `createAgentSession({ sessionManager: SessionManager.inMemory(), modelRuntime })` → `session.prompt(text)`. Exactly one factory call to get a working agent session.
- **Provider breadth without vendor coupling**: Anthropic, OpenAI, Google, Vertex, Bedrock, Azure OpenAI, DeepSeek, xAI, Groq, Mistral, OpenRouter, llama.cpp; env-var keys or custom entries in `~/.pi/agent/models.json`. artai adds none of its own.
- **Session trees**: JSONL entries with id/parentId — durable, branchable transcripts. v1 uses in-memory sessions only; the tree format is reserved for the future interactive playground.
- **Tools**: read/write/edit/bash/grep/ls by default — artai runs intent sessions with built-in tools disabled; we want its provider/session/streaming plumbing, not a coding agent loose inside poster generation.

### 11.3 Operational rules (the engineering substance)

1. **Lazy optional peer.** pi is declared `peerDependenciesMeta.optional`; `agent/pi.ts` dynamic-imports it on construction only. Its dependency graph (~20 packages: chalk, jiti, highlight.js…) never enters installs of pure-core consumers — same pattern p5.brush uses toward p5 itself.
2. **Engines split, stated honestly.** pi requires Node ≥22.19; artai base stays ≥20. In-process Pi usage therefore requires ≥22.19, OR hosts pin older Node and spawn pi as a subprocess over its RPC mode (strict LF-delimited JSONL on stdio — their own docs warn against naive line readers). Both paths documented; neither invented.
3. **Pin exact.** A package moving this fast gets `@earendil-works/pi-coding-agent@0.84.3`-style exact pins plus a scheduled upgrade chore, not `^`.
4. **Structured-output contract + escalation ladders.** Prompts demand strict JSON matching the zod drafts. Responses pass `.parse()`; violations retry once with the validator error appended. Token budgets escalate [2048→6048→6048] for intent, [8192→4576→4576] for motif design (reasoning-model token burn is the #1 failure mode). Persistent failure throws `ProviderContractViolation` with stage+reply-preview diagnostics.
5. **Determinism firewall.** The model can only ever *produce* Recipe-domain data upstream of variation/layout. `contentKey = metaphor.subject|relation` folds into the roll namespace, so changing the THEME changes the composition grammar even under one seed. Envelope `meta.intentSource` records provenance chain (`browser:model +liveMotif +refined`); replay loads frozen recipes, never re-invokes.
6. **Residue safety.** StyleAnalyzer output merges through the schema: sample-residue fields are dropped by validation, fixed/variable merge only after user confirmation in interactive flows.
7. **Caching (three-phase, on by default in Studio).** Intent drafts, motif specs and refined prompts each memoize independently on their own key. The web toggle (default ON) lives in Settings; CLI/library keeps cache opt-in. Clear button wipes all entries atomically.

Test strategy gains one tier: **provider contract tests** run any implementation (Heuristic always; a recorded MockTranscript in CI; live-model tests behind an explicit env flag, never default CI) against schema conformance and fallback semantics.

---

## 12. Platform matrix and the determinism contract

Supported environments:

| Environment | core | prompt | render |
|---|---|---|---|
| Modern desktop browsers (WebGL2) | ✅ | ✅ | ✅ |
| Headless Chromium + SwiftShader (CI/docker) | ✅ | ✅ | ✅ (validated in CI) |
| Worker + OffscreenCanvas | ✅ | ✅ | roadmap |
| Bare Node, no GPU | ✅ | ✅ | returns `RenderCapabilityError` — first-class, documented, not a crash |

`artai.capabilities()` exposes `{ webgl2, offscreenCanvas, fontsReady }` plus the LLM transport status (`none | browser-key | pi-node`, resolved from what the user has configured — see §18.4) so callers choose backends instead of catching failures.

**Determinism claims are scoped explicitly** (the earlier draft's "byte-for-byte" was an overclaim):

| Claim | Guarantee |
|---|---|
| seed → Recipe/Variation picks | exact, any platform (integer hashing, table-based trig) |
| seed → Plan/Scene IR | exact, cross-platform (IEEE-754 double arithmetic only in core) |
| seed → pixels | bit-stable *within* one GPU/browser/driver combination; NOT across vendors |
| Cross-machine verification method | PNG golden per CI image + pixelmatch perceptual diff threshold; text antialiasing excluded from strict identity by measuring geometry not ink at edges |

Batch mode is `seed = baseSeed ⊕ index` derivation, so any member regenerates alone.

## 13. Typography implementation (real gap, decided here)

p5.brush ships **no text capability**. Zine demands 10 typography modes (edge-pressed phrase, ghost text, fragmented letters-as-image, microtext, headline-as-object…). Decision:

- **Primary path: glyph outlines → Polygons via `opentype.js`** (~bundled-size cost accepted, cached per font). Outlines make letters first-class geometry: hatchable ghost text, letterpress bleed on type, fragmented-type-as-image, misregistration channels — all for free since those recipes already work on polygons.
- **Microtext fallback: native 2D `fillText`** below ~8px effective size where outline fidelity buys nothing.
- **Font policy:** bundled OFL-licensed WOFF2 subsets only. Initial set mapped to the zine families: typewriter=`Courier Prime`, mono-grotesk=`Space Mono`, old-serif=`EB Garamond` (replaceable wholesale via StylePackage.fontSet). License compliance list shipped in `docs/FONTS.md`.

## 14. Quality gate, repair loop, errors

Gate = two tiers. **Core checks** (always run, pure math on Plan/IR): negative-space budget, cluster scale, mark-count limits, hue-carrier classification, batch adjacency rules, metaphor vocabulary scan (nautical/generic-pictogram token blacklist for non-maritime themes — eval #8 as code). **Pixel checks** (render env only): downsampled-canvas accent-share sampling, thumbnail-scale chroma visibility, paper-tone variance.

Repair loop mirrors the zine contract, generalized and bounded:

```ts
async function realize(recipe, opts) {
  let best = null, violations = [];
  for (let attempt = 0; attempt < (opts.maxAttempts ?? 2); attempt++) {
    const seed = deriveSeed(recipe.seed, attempt);
    const plan = solveLayout(recipe, seed);
    tighten(recipe, plan.violations);            // drop marks → shrink cluster, zine's density rule
    const ir = compileScene(plan);
    const out = await backend.fold(ir);
    const result = await gate.check(plan, ir, out);
    if (result.pass) return ok(result, { attempts: attempt + 1 });
    violations = result.violations; best = compare(best, result);
  }
  return degraded(best, violations);             // NEVER silent success
}
```

Every outcome ships the same envelope:

```ts
type Envelope = {
  recipe; plan; ir;                              // the whole chain, inspectable
  canvas? : RenderOutput;                        // render/hybrid only
  prompt? : string;                              // if requested/backend=prompt
  gate:    { pass: boolean; measured: Record<string, number>;
             violations: ViolationCode[] };
  meta:    { seedUsed; attempts; degraded: boolean;
             intentSource: "heuristic" | "llm:<model>" | "llm:<model>";
             durationMs };
};
```

Violation codes are a closed enum (`NEGSPACE_OUT_OF_RANGE`, `ACCENT_SHARE_LOW/HIGH`, `HUE_CARRIER_DOT_ONLY`, `BATCH_REPEAT_ADJACENT`, `FORBIDDEN_METAPHOR_TOKEN`, `PRESERVATION_DRIFT`…) so callers branch programmatically instead of parsing prose. Error taxonomy: `SchemaError` (input), `VariationExhaustedError` (constraints unsatisfiable), `RenderCapabilityError` (env), `ProviderError` (agent transport/auth — absorbed by the §11.3 fallback chain and surfaced only through `intentSource`), plus the degraded-not-thrown envelope path for gate outcomes.

## 15. Testing pyramid and automated evals

| Tier | What | Where | Needs GPU |
|---|---|---|---|
| Unit | pure-layer behavior; schema round-trips; migrations | Node, ms-fast | no |
| Provider contracts | any IntentProvider/StyleAnalyzer impl (Heuristic always; recorded MockTranscript in CI; live behind env flag) yields schema-valid drafts and falls back correctly | Node | no |
| Property | N=200 random seeds: post-solver plans satisfy negative-space/cluster/mark budgets; batch adjacency holds; vocabulary scan soundness | Node | no |
| Golden (IR) | compiled Scene IR JSON snapshots per fixture recipe | Node | no |
| Golden (visual) | rendered PNG vs committed goldens, pixelmatch ≤ threshold | Chromium job | yes |
| Evals (zine) | the 8 skill behaviors mechanized — see table | mixed | partly |

Zine-eval mechanization highlights: #1 anti-default-layout → variation assertion that requested-novelty produces family ≠ `center-fragment`; #2 article→single relation → intent unit test; #3 reference analysis → StylePackage load + fixed/variable/residue separation on the six example JPEGs as fixtures; #5/#6 preservation → hybrid box/invariant assertions; #7 grammar-only inheritance → residue-field exclusion test; #8 → token blacklist + share assertions.

CI: `ci.yml` stages typecheck → lint(boundaries) → unit+property → build(esm/cjs/d.ts, subpaths) → visual (chromium + swiftshader, artifacts uploaded on diff) ; `release.yml`: changesets, npm provenance.

## 16. Extensibility

Four registries, each a validated interface + built-in implementations users extend by registration (not subclassing):

```ts
registerLayoutFamily(name: string, impl: LayoutFamily)   // name→coordinate fn + budget hints
registerFocalForm(name, impl)                             // form→ops emitter
registerTextureMode(name, impl)                           // texture→state-block + post-treatment
StylePackage (data)                                       // fixed/variable/residue/fontSet/avoidList
```

Custom brushes/fields pass straight through to p5.brush's own `add()`/`addField()` — artai adds no shadow registry there by design. Plugins receive and return plain data + op emitters; `irVersion` gates new op kinds so third-party ops declare themselves.

## 17. Running it — artifacts, quickstart, deployment

Four ways to use artai, one repo:

| Artifact | For | Form |
|---|---|---|
| **`artai` library** (`packages/artai`) | JS developers embedding generation in their own apps/sketches | npm package: root import (render), `./core`, `./agent` subpaths |
| **`artai` CLI** (`artai` bin in the same package) | scripting, batch runs, CI posters | `npx artai make "theme" --seed 42 --out poster.png --backend render\|prompt\|hybrid`; `artai batch theme.txt --count 6`; `artai recipe schema`, `artai doctor` (env/capability report) |
| **Studio** (`apps/studio`) | designers and non-coders; also where model config lives (§18) | static SPA — hosted or self-served locally |
| **Examples** (`examples/`) | learning + dogfooding | browser sketches and node scripts, deployed alongside Studio to Pages |

### Quickstart

```bash
# A. Use the library
npm install artai                       # p5.brush is a peer dep you install for the render flavor
node my-poster.mjs                      # see API sketch in §8

# B. Run Studio without any install (hosted)
open https://<org>.github.io/artai/     # everything client-side, nothing uploaded

# C. Self-host Studio locally — still no backend
git clone <repo> artai && cd artai && npm install
npm run dev                             # Vite dev server → http://localhost:5173
npm run build                           # outputs packages/artai dist + apps/studio dist/
npx serve apps/studio/dist              # serve the SPA from any static file server

# D. Develop
npm run test          # unit + property (Node) · provider-contract (MockTranscript)
npm run test:visual   # Playwright goldens (chromium, software GL) — CI-identical
npm run release       # changesets versioning flow
```

**Deployment** mirrors the p5.brush `deploy.yml` pattern already adopted as a standing practice (§6.1): every push to `main` builds the library then publishes `apps/studio/dist` (+ examples) as a GitHub Pages artifact. No server exists; the SPA plus static assets *is* the product surface, so Pages-capable hosting of any kind works.

## 18. Studio — the web app and its frontend design

### 18.1 Stack decision (AD-11)

**Vite + Svelte 5, SPA mode, TypeScript strict.** Rationale: the UI is a canvas-heavy control panel with lots of small reactive bindings (sliders ↔ seed ↔ preview), where Svelte's store/reactive model produces the smallest bundle and least boilerplate; we ship zero SSR/server requirements, so SvelteKit's server machinery would be dead weight — plain SPA mode it is. React was considered and rejected as heavier for this shape; the engine API is framework-agnostic either way, so the studio can be rewritten without touching `packages/artai`.

### 18.2 Screens

1. **Create** — theme input; photo attach with role + preservation pickers; StylePackage select; seed field with dice/shuffle scrubber; backend selector (render / prompt / hybrid); "use LLM intent" toggle showing live transport status badge.
2. **Result** — mat-framed 3:5 preview; gate readout (air %, accent %, violations as doc-linked chips); tabs `PNG | IR | PROMPT`; export / copy / save-to-library; pipeline stepper (intent→recipe→layout→scene→render→gate) driven by Envelope progress events.
3. **Batch** — grid run with variety metrics surfaced (layout families used, adjacent-repeat warnings); per-cell regenerate-from-derived-seed.
4. **Library** — saved Recipes/Envelopes (IndexedDB), provenance history (`intentSource`, model, seeds), JSON import/export.
5. **Settings** — model configuration vault (§18.4), font/theme prefs, cache controls.
6. **Docs/help** — embedded llms.txt view + capability report (`artai.doctor()` equivalent rendered read-only).

```
┌──────────────────────────────────────────────────────────────┐
│ artai ◌ studio        Create   Batch   Library      ⚙        │
├────────────────────────┬─────────────────────────────────────┤
│ THEME                  │                                     │
│ ┌────────────────────┐ │       ┌───────────┐                 │
│ │ the last train     │ │       │   3:5     │                 │
│ │ home               │ │       │  poster   │                 │
│ └────────────────────┘ │       └───────────┘                 │
│ PHOTO attach ▢  role▾  │  gate ✓ air 84% · accent 1.9%       │
│ STYLE quiet-editor ▾   │  violations: none                   │
│ SEED [ 42 ⟳ ] BACKEND▾ │  ── PNG · IR · PROMPT ──            │
│ ☐ LLM intent  [● none] │  export · copy · save               │
│             [GENERATE] │  step 4/6 ▪ scene compile…          │
└────────────────────────┴─────────────────────────────────────┘
```

### 18.3 Engine integration notes

Rendering happens against the same public API sketched in §8; the stepper maps onto pipeline stages because each stage already returns inspectable data (Recipe→Plan→IR→Envelope). v1 renders on the main thread between frames (posters are single-shot, not realtime); Worker + OffscreenCanvas moves over unchanged once landed per §12 roadmap. Share links encode `{recipeId}` or full Recipe JSON in the URL hash — recipients replay deterministically by seed without any server state; LLM-provenance travels inside the frozen Recipe, never re-invoked.

### 18.4 Model configuration on the web

Three transports exist; Settings exposes exactly what the current transport allows:

| Transport | Where it runs | Config UX |
|---|---|---|
| `none` | **removed from the Web product** (heuristic tier stays library/CLI-only); Settings shows a configuration-required state and GENERATE refuses until preset/key/model are complete |
| `browser-key` (**Studio default**) | fetch straight from the browser to the chosen provider | Provider preset dropdown (Anthropic / OpenAI / Gemini / OpenRouter / custom OpenAI-compatible base URL); API key field; model id text+suggest; thinking level; **Test connection** button (cheapest endpoint); optional monthly spend cap estimate |
| `pi-node` | CLI / self-hosted Node contexts only (§11) | reads the same providers through pi sessions; Settings offers "import models.json" for parity, and explains why this option is N/A in a pure-static tab |

Security posture, stated in-product not just here: keys are stored in `localStorage` under `artai.keys.*` by default with copy warning that they are local-only (requests go browser→provider directly; nothing else receives them); a session-only toggle keeps them in memory and forgets on close; keys are excluded from share links, exports, and envelope saves by construction (they never enter Recipe/Envelope data). CORS reality check ships in docs: Anthropic requires the documented direct-browser-access header, OpenAI/OpenRouter/Gemini accept browser origins — this is why presets, not raw endpoints, are the primary UX.

### 18.5 Design language

The Studio itself practices the zine aesthetic it generates:

- **Tokens:** paper tones (`--paper #F5F0E6`, elevated `#FBF7EE`), ink `#1A1A1A`, hairline rules instead of card shadows, generous whitespace echoing the 70–90% negative-space doctrine.
- **Accent theming:** after each generation the app re-tints its accent variable to that poster's chromatic hue — the tool wears its output. Contrast is machine-checked: accent-on-paper combinations must pass WCAG AA for interactive elements regardless of how vivid the art accent is (the zine look tempts low contrast; the linter is the discipline).
- **Type roles:** humanist sans for UI, typewriter/mono family for numbers, seeds, IR and prompt sheets — mirroring the poster's own font-set semantics.
- **Motion:** 120–200 ms eases only, `prefers-reduced-motion` honored everywhere; generation progress communicates via text+stepper, not animation walls.
- **Components:** `Panel`, `SeedField`, `RatioFrame` (poster mat), `GateReport` chips, `CodeSheet` (IR/PROMPT mono viewers), `KeyVault` forms, `ThumbnailGrid`.

**CJK typography note (honest scope):** bundled Latin OFL fonts don't cover Chinese microtext; poster CJK strings render via the native canvas path with system fonts in v1, glyph-subset outline treatment (harfbuzzjs WASM at generation time, using only the characters present in `recipe.type.text`) is roadmapped. UI copy ships zh-CN + en with `Intl` routing; zh-CN is the default since the source skill's own usage examples lead in Chinese.

---

## 19. Tooling, licensing, provenance

- **Language/toolchain:** TypeScript strict; vitest projects (node/chromium); vite lib-mode build; biome or eslint+prettier for format (one tool, enforced in CI).
- **Dependencies:** core = `zod` only. render adds `opentype.js`. Peers: `p5.brush ^2.x` (which itself peers p5 ^2.2 for the p5 flavor; the standalone flavor needs nothing) and `@earendil-works/pi-coding-agent` **exact-pinned** at `0.84.x`, declared optional — dynamically imported only by `artai/agent/pi`; in-process use requires Node ≥22.19, otherwise run pi as a subprocess over its RPC mode. Everything MIT.
- **Licensing/attribution:** artai MIT; concept lineage credited to gc-minimal-zine-poster (MIT, © 2026 LiamGvchi) and rendering to p5.brush (MIT, Alejandro Campos Uribe); fonts OFL with subset provenance in `docs/FONTS.md`. No telemetry, no network calls at runtime; photo assets referenced by content hash, never uploaded.

### 17.1 Do we need third-party system tools? (ffmpeg et al. — analyzed)

**Policy, three tiers:**

- **Tier 0 — runtime:** pure JS/WASM modules only. No `child_process`, no native `.node` addons, no CLI invocation anywhere in shipped code. Worker-safe by construction.
- **Tier 1 — dev/CI:** heavyweight native-capable tools allowed behind a written justification. Exactly one exists: **Playwright + Chromium**, whose bundled ANGLE/SwiftShader provides a driver-less software GL stack — meaning CI/docker needs no GPU vendor drivers installed.
- **Tier 2 — authoring-time, build-machine only, committed outputs:** font subsetting runs once via `pyftsubset` (fonttools) or `subset-font` (harfbuzzjs WASM); the resulting OFL woff2 subsets are committed to `assets/fonts/`. Runtime installs nothing.

**Candidate-by-candidate verdicts** (recorded so nobody relitigates blind):

| Candidate | Verdict | Reason |
|---|---|---|
| **ffmpeg** | ❌ not needed (v1) | Artifacts are still images: decode/encode is native to the platform (`canvas.toBlob`, `OffscreenCanvas.convertToBlob`). Even animated posters would export WebM in-browser via `canvas.captureStream()` + `MediaRecorder` — still no ffmpeg. The first genuine need would be server-side MP4/H.264 transcode; parked as an explicit non-goal until an actual use case exists. |
| ImageMagick / GraphicsMagick CLI | ❌ | Golden-image diffing is `pixelmatch` (pure JS); resampling uses native `drawImage`; bulk format conversion is outside the input contract. |
| sharp / jimp (image processing) | ❌ | Pixel-gate sampling downsamples the live canvas in the same GL process — no second runtime exists that would need sharp (bare Node has no render duties, per §12 matrix). |
| PDFKit / pdf-lib | ❌ for now | Roadmapped print export reuses the already-required Chromium (`Page.printToPDF`) — zero new binary. `pdf-lib` returns only if a true vector-PDF emitter over IR ops becomes a requirement. |
| resvg / librsvg | ❌ | The future SVG exporter *generates* SVG strings (dependency-free); rasterizing SVG belongs to the browsers we already require. |
| exiftool | ❌ | Recipe provenance rides in a PNG `tEXt` chunk written by a tiny pure-JS chunk reader/writer (optional utility); source-photo EXIF is never modified. |
| Font subsetter | ✅ Tier 2 only | See policy above — outputs committed, nothing installed at runtime. |
| Playwright + Chromium | ✅ Tier 1 | The one sanctioned heavyweight: headless render tests, smoke suite, visual goldens, future PDF. Driverless GL means plain container images work. |
| simplex-noise | (transitive) | Arrives via p5.brush; pure JS, WASM-free. Not ours to manage. |

**Sole guardedException in shipped code:** the optional agent tier may spawn `pi --mode rpc` as a subprocess (Node ≥22.19 hosts that choose that transport, §11.3). It is reached only through a dynamic import behind explicit configuration; the default build never references `child_process`.

**Honest capability ceilings accepted rather than papered over with tools:**

- Max single-pass canvas ≈ GPU/driver limits (commonly ≤16384 px per side). Ultra-large prints become a tiled-rendering roadmap item, not a reason to bolt on ImageMagick stitching.
- Input photo/reference contract: browser-decodable formats (JPEG/PNG/WebP/GIF-first-frame/AVIF where supported). HEIC/TIFF are explicitly out of contract; users convert upstream. Animated references contribute their first frame — consistent with the zine skill treating references as stills.

## 20. Design decisions log (with rejected alternatives)

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| AD-1 | Recipe as central serialized artifact | both backends + tests + external tools consume it | implicit config objects passed down call chains |
| AD-2 | Explicit Scene IR between layout and backends | symmetry, GPU-free testing, future exporters | backends read Plan directly |
| AD-3 | Pure core / effectful shell split, lint-enforced | 90% testable everywhere; headless-first | one src tree with "be careful" comments |
| AD-4 | TypeScript + zod single-source schemas + JSON Schema export | type safety across the serialize boundary; interop with the skill ecosystem | JSDoc types; runtime validation as afterthought |
| AD-5 | Scoped determinism (exact logic, per-env pixels) | honest about float/GL variance | promising byte-exact rasters universally |
| AD-6 | opentype.js outlines for type | unlocks hatchable/fragmented type recipes on real geometry | treating text as untouchable bitmap passthrough |
| AD-7 | Bounded repair loop with violation-code envelope | mechanizes zine's regenerate-once-then-be-honest rule | throw on first gate failure |
| AD-8 | p5.brush as un-forked peer dep | inherit its maintenance, hook architecture, standalone build | vendoring/forking |
| AD-9 | Model calls behind core-defined ports; pi-coding-agent as lazy optional peer with exact pin | deterministic core stays dep-light and offline-capable; pi's provider breadth without vendor coupling; engines split handled honestly | model SDK imported inside core intent modules; raw provider SDKs re-implemented per vendor |
| AD-10 | Zero native binaries at runtime; ffmpeg / ImageMagick / sharp all rejected; Playwright-Chromium is the only sanctioned heavyweight (dev/CI), pi-RPC-subprocess the sole guarded exception | `npm install` stays the entire deployment story; browser platform already covers decode/encode/scale/PDF/animation; full analysis in §19.1 | bolting on media CLIs "just in case"; server-side transcoding speculative infrastructure |
| AD-11 | Studio ships as an in-repo Svelte 5 SPA consuming the local library package; model config is BYOK straight from browser to the chosen provider | zero backend keeps AD-10 intact; API keys never touch anything we operate; one reactive-rendering framework for a canvas-heavy control-panel UI | standing up a server component first; shipping the studio as part of the npm library bundle |
| AD-12 | Dual rasterizer over one Scene IR: p5.brush (WebGL2) primary, deterministic Canvas-2D fallback; crisp chrome (type/marks/grain) painted by a shared overlay on both | Studio always produces an image; the fallback doubles as the pixel-diff reference for future visual goldens since it is byte-reproducible | letting the product hard-fail without WebGL2 |
| AD-13 | Motif vignette layer: keyword scan of the metaphor selects one of N hand-authored stroke vignettes emitted as a `motif` IR op | the poster's ONE small imageable event becomes visible pixels without an image-generation model; deterministic and testable | shipping composition-only output that ignores the theme's nouns |
| AD-14 | Intent `mood` steers the hue pool; Studio derives a fresh effective seed per click while displaying the used seed as the replay key | closes the "model ran but picture unchanged" gap; visual re-roll UX without breaking §12 determinism (displayed seed IS the replay key) | uniform random hues divorced from mood; freezing the seed so repeat clicks redraw identical posters |
| AD-15 | Third backend demoted to **supplement tier**: BYOK `ImageGenClient` ships but is opt-in (visible only when an image model is configured); the procedural p5.brush/Canvas render line is the mainline, with its painters upgraded via p5.brush's own realism algorithms (multi-plate grow fills, stamped strokes, mood→palette) | the zine contract's raster step stays reachable for users who want it; deterministic art remains free, reproducible and architecturally primary — realism of that line scales by iterating painter functions against a visual harness | making AI images the default; treating hand-authored procedural painting as incapable — it caps only at its author's iteration bandwidth, which a see-and-adjust loop extends |

Rejected outright (with reasons, so nobody relitigates blind):

- **Monorepo/multi-package split of the library** — still premature; `packages/artai` is one package with enforced internal boundaries. The workspaces layout exists solely to host `apps/studio` alongside it without coupling their release cycles.
- **Custom software rasterizer for headless** — would forfeit p5.brush's entire natural-media value (that IS the product); SwiftShader in CI covers the need.
- **Ship an image-model API client** — ~~the prompt backend emits strings; binding to a vendor is user code~~ **superseded (AD-15):** the zine skill's own contract terminates in a generated raster, so a BYOK `/images/generations` client now ships as the third backend while the deterministic render tier remains the zero-cost preview.
- **Reactive/streaming API** — posters are finite artifacts; envelopes suffice.

## 21. Build order

1. ✅ `core/types` — zod schemas, inferred TS types, JSON-Schema export, migrations scaffold.
2. ✅ `core/recipe` — variation engine (six axes, weighted seeded picks, **mood→hue pool**) + constraints (batch rules as code).
3. ✅ ~~`agent/heuristic`~~ **deleted** per think-first contract; stub fixtures cover library tests.
4. ✅ `core/prompt` — four-paragraph compiler with measured numbers.
5. ✅ `core/layout` — ten families, monotone ink-budget solver (200-seed property-verified), `measure.ts`.
6. ✅ `core/scene` — IR compiler incl. `motif` op (model-chosen from 14-item palette via `visual.motifId`); JSON golden harness ⏳.
7. ✅ v0.9 `render/ops/paper + press + fill/hatch` — dual rasterizer: p5.brush standalone (flow-field edges, per-treatment brushes, cross-hatch) ⊕ deterministic canvas-fallback ⇄ shared overlay (§9→§10).
8. ◐ `render/type` — canvas text interim shipped; opentype outline path + font subsets pending (§13).
9. ✅ focal/marks/bicycle/creature shipped (14 painters incl. single-silhouette animals) · photo asset wiring for hybrid ⏳.
10. ✅ `gate/checks-core` (dual-branch accent contract) + bounded repair loop + envelope.
11. ⏳ `render/gate/checks-pixel` + visual goldens + zine-eval fixtures.
12. ⏳ `styles/loader` + StyleAnalyzer contracts.
13. ✅ `designMotif` + `refinePrompt` shipped on BrowserIntentProvider; pi adapter remains optional extension point.
14. ✅ `apps/studio` wave 1 — Create/Result/**poster PNG**/Gate/Settings/BYOK vault, derived-seed re-roll UX, model-required policy.
15. ⏳ Studio wave 2 — batch grid metrics, library persistence, share links, embedded llms.txt view.
16. ⏳ Docs tooling — CI-generated `docs/llms.txt`.
17. ⏳ Intent UX polish — last: fuzzy, replaceable, everything above runs without it.
