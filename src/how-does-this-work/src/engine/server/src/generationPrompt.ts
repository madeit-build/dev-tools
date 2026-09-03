import { GenerationFailedError, type DraftTour } from "./tourGenerator.js";
import type { TourSummary } from "@made-i-t/hdtw-protocol";

export const SYSTEM_PROMPT = `You are a principal engineer creating a guided tour of a codebase for a new team member.

You will be given a topic. Explore the codebase with your tools (Read, Grep, Glob) until you genuinely understand how that topic works, from entrypoint to exit. Then produce a tour: 4 to 8 steps, each anchored to a specific range of lines in a specific file, ordered so a newcomer can follow the flow.

Rules for anchors:
- Before anchoring a step, Read the file and confirm the exact CURRENT line numbers of the code you are anchoring. Line numbers must be 1-based and inclusive.
- Anchor the smallest range that contains the construct you are explaining (a function, a block, a declaration) — typically 3 to 25 lines.
- File paths must be relative to the workspace root, using forward slashes.

Prefer a SYMBOL-ANCHOR when the code you are anchoring is a whole named declaration
(function, class, method, exported const): call findSymbol to confirm it exists, then
emit the anchor as { "file": "relative/path.ts", "symbol": "Name" } (or "Class.method")
WITHOUT line numbers — the engine resolves and tracks it as code evolves. Use a
line-anchor { "file", "startLine", "endLine" } only for a sub-region that is not a
single named symbol.

Rules for narration:
- 2 to 4 sentences per step, in Markdown.
- Explain WHY the code is the way it is — patterns, architecture, intent — not just what it does. Speak like a senior engineer walking someone through the system.

Your FINAL message must be ONLY a fenced JSON block in exactly this shape, with no other prose. The "relatedTours" array is OPTIONAL and only allowed when the workspace lists tours you may link to. For symbol-anchors omit startLine/endLine; for line-anchors omit symbol:

\`\`\`json
{
  "title": "Short tour title",
  "summary": "One-sentence summary",
  "steps": [
    {
      "title": "Step title",
      "narration": "Markdown narration.",
      "anchor": { "file": "relative/path.ts", "symbol": "functionName" },
      "relatedTours": [{ "tourId": "existing-tour-id", "label": "Optional link text" }]
    },
    {
      "title": "Step title (line-anchor example)",
      "narration": "Markdown narration.",
      "anchor": { "file": "relative/path.ts", "startLine": 10, "endLine": 24 }
    }
  ]
}
\`\`\``;

export function catalogSection(catalog: TourSummary[]): string {
  if (catalog.length === 0) {
    return "";
  }
  const lines = catalog.map((tour) => `- ${tour.id}: ${tour.title}`).join("\n");
  return `\n\nThe workspace already has these tours. Where a step naturally leads into one of them, you MAY add a "relatedTours" array to that step with the exact id (and an optional label). Only reference ids from this list:\n${lines}`;
}

export function generatePrompt(topic: string, catalog: TourSummary[]): string {
  return `Create a guided tour for this topic: ${topic}${catalogSection(catalog)}`;
}

export function repairPrompt(
  topic: string,
  draft: DraftTour,
  anchorErrors: string[],
): string {
  return `You previously drafted this tour for the topic "${topic}":

\`\`\`json
${JSON.stringify(draft, null, 2)}
\`\`\`

These anchors failed verification against the actual files:
${anchorErrors.map((error) => `- ${error}`).join("\n")}

Re-read the affected files, fix ONLY the broken anchors (adjust line ranges or choose a better location), and output the corrected complete tour in the required fenced JSON format.`;
}

export function parseDraft(resultText: string): DraftTour {
  const fenced = [...resultText.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1]
                 ?? resultText;
  let raw: unknown;
  try {
    raw = JSON.parse(fenced.trim());
  } catch {
    throw new GenerationFailedError(
      "agent output was not valid JSON in the required format",
    );
  }
  const errors = validateDraft(raw);
  if (errors.length > 0) {
    throw new GenerationFailedError(
      `agent output failed draft validation: ${errors.join("; ")}`,
    );
  }
  return raw as DraftTour;
}

function validateDraft(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["draft must be a JSON object"];
  }
  const draft = value as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof draft.title !== "string" || draft.title.length === 0)
    errors.push("title missing");
  if (typeof draft.summary !== "string") errors.push("summary missing");
  if (!Array.isArray(draft.steps)
      || draft.steps.length === 0
      || draft.steps.length > 12
  ) {
    errors.push("steps must be a non-empty array of at most 12");
    return errors;
  }
  draft.steps.forEach((step, index) => {
    if (typeof step !== "object" || step === null) {
      errors.push(`steps[${index}] must be an object`);
      return;
    }
    const candidate = step as Record<string, unknown>;
    if (typeof candidate.title !== "string" || candidate.title.length === 0)
      errors.push(`steps[${index}].title missing`);
    if (typeof candidate.narration !== "string"
        || candidate.narration.length === 0
    )
      errors.push(`steps[${index}].narration missing`);
    const anchor = candidate.anchor as Record<string, unknown> | undefined;
    const isSymbolAnchor = anchor !== undefined
                           && typeof anchor.file === "string"
                           && typeof anchor.symbol === "string"
                           && anchor.symbol.length > 0;
    const isLineAnchor = anchor !== undefined
                         && typeof anchor.file === "string"
                         && Number.isInteger(anchor.startLine)
                         && Number.isInteger(anchor.endLine);
    if (!isSymbolAnchor && !isLineAnchor) {
      errors.push(`steps[${index}].anchor incomplete`);
    }
    if (candidate.relatedTours !== undefined) {
      if (!Array.isArray(candidate.relatedTours)) {
        errors.push(`steps[${index}].relatedTours must be an array`);
      } else {
        candidate.relatedTours.forEach((link, linkIndex) => {
          const entry = link as Record<string, unknown> | null;
          if (typeof entry !== "object"
              || entry === null
              || typeof entry.tourId !== "string"
              || entry.tourId.length === 0
          ) {
            errors.push(
              `steps[${index}].relatedTours[${linkIndex}].tourId must be a non-empty string`,
            );
          }
        });
      }
    }
  });
  return errors;
}
