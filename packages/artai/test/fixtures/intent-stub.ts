/**
 * Deterministic IntentProvider stub for tests/evals — mirrors the MODEL
 * contract (theme thinking happens first, motifHint mandatory in practice),
 * but the theme->motif table below is fixture data only.
 */
import type { IntentDraft } from "../../src/core/types/index.js";
import type { IntentProvider, ParseInput } from "../../src/core/types/index.js";
import type { PhotoRole } from "../../src/core/types/index.js";
import { IntentDraftSchema } from "../../src/core/types/index.js";

const HINT_TABLE: Array<{ re: RegExp; id: string }> = [
  { re: /信|邮|letter|mail/i, id: "envelope" },
  { re: /雨|水珠|rain|drop/i, id: "rain-on-glass" },
  { re: /蝉|夏天|cicada|summer/i, id: "moth-cicada" },
  { re: /海边|潮|海|下午|tide|sea|shore/i, id: "tide-mark" },
  { re: /窗|window|glass pane/i, id: "window-ajar" },
  { re: /自行车|单车|骑行|bicycle|bike/i, id: "bicycle" },
  { re: /书|book|read/i, id: "open-book" },
  { re: /列车|站台|火车|train|rail|platform/i, id: "platform-rails" },
  { re: /门|door|keyhole/i, id: "door-light" },
  { re: /杯|凉水|cup|ice/i, id: "cup-melt" },
  { re: /枝|叶|花|branch|leaf/i, id: "branch-leaf" },
  { re: /楼梯|缺口|stair|missing/i, id: "stair-gap" },
  { re: /明信片|邮票|postcard|stamp/i, id: "postcard-stamp" },
];

const MOOD_TABLE: Array<[RegExp, string]> = [
  [/夏|cicada|summer/i, "summer"],
  [/夜|晚|night/i, "night"],
  [/海|tide|shore/i, "seaside"],
  [/童年|childhood/, "childhood"],
  [/孤独|solitude/, "solitude"],
  [/午后|afternoon/i, "afternoon"],
  [/回忆|memory/, "memory"],
  [/梦|surreal/i, "surreal"],
  [/静|安静|雨|quiet/i, "quiet"],
];

const SUBJECT_BANK: Record<string, string> = {
  "迟迟没有寄出的信": "an unsealed envelope pressed under a flat stone",
  "蝉声很长的夏天": "a single cicada shell on pale curtain fabric",
  "梅雨季的窗": "three water dots held on glass",
};

function roleFor(utterance: string): PhotoRole | null {
  if (/参考.{0,6}(风格|配色|构图)/.test(utterance)) return "reference-image";
  if (/(把|将)?.{0,12}(放进去|放进海报)/.test(utterance)) return "supporting-insert";
  if (/把这张|基于这张|用这张|保留|做成海报|还是(要)?一眼认得/.test(utterance))
    return "edit-target";
  if (/照片|图|photo|image/i.test(utterance)) return "edit-target";
  return null;
}

export class StubIntentProvider implements IntentProvider {
  readonly id = "stub";

  constructor(private readonly forcedHint?: string) {}

  async parse(input: ParseInput): Promise<IntentDraft> {
    const theme = input.theme.trim();
    let hint: string | undefined =
      this.forcedHint ?? HINT_TABLE.find((h) => h.re.test(theme))?.id;

    // cicada-priority for explicit summer-night phrasing used in fixtures
    if (/蝉/.test(theme)) hint = "moth-cicada";
    if (/雨/.test(theme) && !/夏天/.test(theme)) hint = "rain-on-glass";

    const subj =
      theme.includes("信")
        ? "an unsealed envelope pressed under a flat stone"
        : theme.includes("冰")
          ? "a half-melted ice cube in a shallow glass"
          : theme.includes("雨")
            ? "raindrops clinging to the pane"
            : theme.includes("海")
              ? "foam lines on wet sand"
              : theme.includes("书")
                ? "a bookmark ribbon on a closed book"
                : hint === "moth-cicada"
                  ? "an empty cicada shell on a twig"
                  : `subject keyed to ${hint ?? "quiet"}`;

    const draft: IntentDraft = {
      mode: input.hasPhoto ? "photo-input" : "generate",
      thesis: theme,
      metaphor: {
        subject: subj,
        relation: "still becoming",
      },
      mood: "quiet",
      shortText: null,
      lang: /[\u4e00-\u9fff]/.test(theme) ? "zh" : "en",
    };
    // MANDATORY per model contract — determinism here maps theme -> palette id
    (draft as { motifHint?: string }).motifHint = hint ?? "open-book";
    return IntentDraftSchema.parse(draft);
  }

  async classifyRole(u: string): Promise<PhotoRole | null> {
    return roleFor(u);
  }
}
