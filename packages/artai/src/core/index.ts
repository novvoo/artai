export { solveLayout, type Plan } from "./layout/solver.js";
export { compileScene, type SceneIR, type SceneOp } from "./scene/compile.js";
export { compilePrompt, paragraphCount } from "./prompt/compile.js";
export { compileStructuredPrompt } from "./prompt/structured.js";
export { irToScript } from "./scene/script.js";
export { CompositionGraphSchema, sanitizeCompositionGraph, scanPartialGraph, critiqueGraph, buildGraphUserPrompt, GRAPH_SYSTEM_PROMPT, type CompositionGraph } from "./scene/graph.js";
export {
  drawGraphToCtx,
  renderGraph,
  graphToScript,
  mulberry32,
  hexToRgba,
  DESIGN_W,
  DESIGN_H,
  type GraphRenderOptions,
  type GraphRenderResult,
} from "./scene/graphRender.js";
export {
  CustomMotifSpecSchema,
  sanitizeCustomMotif,
  applyCustomMotif,
  DEMO_ENVELOPE,
  DEMO_FISH,
  type CustomMotifSpec,
  type ShapeRole,
} from "./scene/custom.js";
export {
  realize,
  realizeBatch,
  type Envelope,
  type RealizeOptions,
  type StageName,
} from "./pipeline.js";
export { checkCore, type Violation, type ViolationCode } from "./gate/checks-core.js";
export { checkBatch, repairBatch, type BatchViolation } from "./recipe/constraints.js";
export { pickRecipe, ALL_FAMILIES, PHOTO_FORMS } from "./recipe/variation.js";
export {
  RecipeSchema,
  parseRecipe,
  recipeJsonSchema,
  RecipeSchemaVersion,
  IntentDraftSchema,
  PhotoRoleSchema,
  PreservationLevelSchema,
  LAYOUT_FAMILIES,
  FOCAL_FORMS,
  TEXTURE_MODES,
  TYPE_MODES,
  POSITIONS,
  HUE_CARRIERS,
  MARK_KINDS,
  MOODS,
  PAPER_TONES,
  ACCENT_HUES,
  type Recipe,
  type IntentDraft,
} from "./types/index.js";
