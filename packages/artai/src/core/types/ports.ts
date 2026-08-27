/**
 * Provider ports — interfaces live in core; implementations live in agent/.
 * Core consumes drafts explicitly and stays free of provider state.
 */
import type { IntentDraft } from "./recipe.js";
import type { PhotoRole } from "./recipe.js";

export interface ParseInput {
  readonly theme: string;
  readonly hasPhoto?: boolean;
}

export interface IntentProvider {
  /** Human-readable id recorded into Recipe.provenance.intentSource. */
  readonly id: string;
  parse(input: ParseInput): Promise<IntentDraft>;
  classifyRole?(utterance: string): Promise<PhotoRole | null>;
}

export interface StyleAnalyzerDraft {
  fixed: Record<string, string>;
  variable: string[];
  avoid: string[];
}

export interface ReferenceSet {
  readonly descriptions: string[]; // filenames/metadata until visual analysis exists
}

export interface StyleAnalyzer {
  readonly id: string;
  analyze(files: ReferenceSet): Promise<StyleAnalyzerDraft>;
}

/**
 * Second-round prompt refinement: a language model ENRICHES the deterministic
 * four-paragraph prompt with sensory specifics while preserving every number,
 * color and geometry clause. Output remains plain text.
 */
export interface PromptRefiner {
  readonly id: string;
  refine(compiledPrompt: string): Promise<string>;
}
