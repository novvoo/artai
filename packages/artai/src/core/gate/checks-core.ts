/**
 * gate/checks-core.ts — pure-math quality checks on Recipe+Plan.
 * These run before any render exists; the render env adds pixel sampling
 * checks on top (§14 of the architecture doc).
 */
import type { Recipe } from "../types/recipe.js";
import type { Plan } from "../layout/solver.js";

export type ViolationCode =
  | "NEGSPACE_OUT_OF_RANGE"
  | "CLUSTER_SCALE_OUT_OF_RANGE"
  | "ACCENT_SHARE_OUT_OF_RANGE"
  | "FORBIDDEN_METAPHOR_TOKEN"
  | "MARK_COUNT_EXCEEDED";

export interface Violation {
  readonly code: ViolationCode;
  readonly measured?: number;
  readonly message: string;
}

const NEG_MIN = 0.45;
const NEG_MAX = 0.86;
const CLUSTER_MIN = 0.09;
const CLUSTER_MAX = 0.52; // raw geometry cap — ink cap lives in negative space
const ACCENT_MIN = 0.008;
const ACCENT_MAX = 0.03; // slight tolerance above the 2.5% style target

const MARITIME = [
  "ship mooring",
  "anchor",
  "buoy",
  "lighthouse",
  "harbor",
  "nautical",
  "sailboat",
];
const MARITIME_ALLOWED = ["sea", "ocean", "tide", "wave", "shore", "maritime", "sail"];

export function checkCore(recipe: Recipe, plan: Plan): Violation[] {
  const out: Violation[] = [];
  const m = plan.measured;

  if (m.negativeSpace < NEG_MIN || m.negativeSpace > NEG_MAX) {
    out.push({
      code: "NEGSPACE_OUT_OF_RANGE",
      measured: m.negativeSpace,
      message: `negative space ${m.negativeSpace} outside [${NEG_MIN}, ${NEG_MAX}]`,
    });
  }
  if (m.clusterShare < CLUSTER_MIN || m.clusterShare > CLUSTER_MAX) {
    out.push({
      code: "CLUSTER_SCALE_OUT_OF_RANGE",
      measured: m.clusterShare,
      message: `cluster share ${m.clusterShare} outside [${CLUSTER_MIN}, ${CLUSTER_MAX}]`,
    });
  }
  // Dual-branch accent contract: pass when the canvas-branch OR the
  // cluster-branch holds (style-system §color). dot/hairline carriers fail
  // both by construction — visible-at-thumbnail demands more than a dot.
  const share = m.accentShareEstimate;
  const canvasBranch = share >= ACCENT_MIN && share <= ACCENT_MAX;
  const rel = m.clusterShare > 0 ? share / m.clusterShare : 0;
  const REL_MIN = 0.12;
  const REL_MAX = 0.45;
  const clusterBranch = rel >= REL_MIN && rel <= REL_MAX;
  if (!canvasBranch && !clusterBranch) {
    const dir =
      share < ACCENT_MIN && rel < REL_MIN
        ? "below minimum — carrier too thin"
        : `above maximum (canvas ${share}, ${Math.round(rel * 100)}% of cluster)`;
    out.push({
      code: "ACCENT_SHARE_OUT_OF_RANGE",
      measured: share,
      message: `accent share ${dir}`,
    });
  }

  if (recipe.marks.length > 3) {
    out.push({
      code: "MARK_COUNT_EXCEEDED",
      measured: recipe.marks.length,
      message: `${recipe.marks.length} decorative marks exceed cap of 3`,
    });
  }

  // eval #8 as code: no maritime grammar unless the theme itself is maritime
  const haystack = `${recipe.metaphor.subject} ${recipe.metaphor.relation}`.toLowerCase();
  const themeIsMaritime = MARITIME_ALLOWED.some((t) => haystack.includes(t));
  if (!themeIsMaritime) {
    for (const token of MARITIME) {
      if (haystack.includes(token)) {
        out.push({
          code: "FORBIDDEN_METAPHOR_TOKEN",
          message: `metaphor introduces "${token}" on a non-maritime theme`,
        });
        break;
      }
    }
  }
  return out;
}
