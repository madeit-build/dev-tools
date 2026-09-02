import { buildReplacement, renderApplied, type Applied } from "./geometry.js";
import { probeHunk } from "./hunks.js";
import type { Adapter, Decision, HangOptions, HangResult } from "./types.js";

const byLine = (a: Decision, b: Decision): number => a.line - b.line;

/** Detects the input's own line ending so the engine can restore it: geometry.ts
 * always splits and joins on bare "\n", so a CRLF input would otherwise come
 * back with its \r stripped from every touched line but kept on untouched ones. */
const detectEol = (text: string): "\r\n" | "\n" => (text.includes("\r\n") ? "\r\n" : "\n");

const withEol = (text: string, eol: "\r\n" | "\n"): string =>
  eol === "\n" ? text : text.replace(/\n/g, eol);

const appliedDecision = ({ hunk, replacement }: Applied): Decision => ({
  line: hunk.headIndex + 1,
  applied: true,
  anchor: replacement.anchor,
  links: replacement.links,
});

/** Collects every candidate that survives the width budget. */
function collect(
  lines: readonly string[],
  adapter: Adapter,
  options: HangOptions,
): { candidates: Applied[]; decisions: Decision[] } {
  const candidates: Applied[] = [];
  const decisions: Decision[] = [];
  let index = 0;

  while (index < lines.length) {
    const probe = probeHunk(lines, index, adapter.continuationTokens);
    if (probe.kind === "skip") {
      index += 1;
      continue;
    }
    if (probe.kind === "reject") {
      decisions.push({ line: index + 1, applied: false, reason: probe.reason });
      index += 1;
      continue;
    }
    const replacement = buildReplacement(lines, probe.hunk);
    if (replacement.lines.some((line) => line.length > options.hangWidth)) {
      decisions.push({ line: index + 1, applied: false, reason: "over-budget" });
      // A run that is over budget as a whole is not retried as a smaller
      // sub-run: skip past it entirely instead of re-probing from inside it,
      // which would just re-hit its equal-indent continuation lines as a
      // spurious "bad-indent".
      index = probe.hunk.endIndex + 1;
      continue;
    }
    // Order matters: index only ever moves forward, so candidates is always
    // ascending and non-overlapping, which is what lets renderApplied walk it
    // with a single forward cursor instead of sorting or checking overlap.
    candidates.push({ hunk: probe.hunk, replacement });
    index = probe.hunk.endIndex + 1;
  }

  return { candidates, decisions };
}

export function hangAlign(text: string, adapter: Adapter, options: HangOptions): HangResult {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const { candidates, decisions } = collect(lines, adapter, options);
  if (candidates.length === 0) return { text, decisions: decisions.sort(byLine) };

  const batch = withEol(renderApplied(lines, candidates), eol);
  if (adapter.verify(text, batch)) {
    decisions.push(...candidates.map(appliedDecision));
    return { text: batch, decisions: decisions.sort(byLine) };
  }

  const kept: Applied[] = [];
  for (const candidate of candidates) {
    if (adapter.verify(text, withEol(renderApplied(lines, [...kept, candidate]), eol))) {
      kept.push(candidate);
      decisions.push(appliedDecision(candidate));
    } else {
      decisions.push({ line: candidate.hunk.headIndex + 1, applied: false, reason: "verify-rejected" });
    }
  }

  return {
    text: kept.length === 0 ? text : withEol(renderApplied(lines, kept), eol),
    decisions: decisions.sort(byLine),
  };
}
