import { createHash } from "node:crypto";

/** Canonical snippet hash: sha256 over the anchored lines joined with "\n". */
export function computeSnippetHash(anchoredText: string): string {
  return "sha256:" + createHash("sha256").update(anchoredText).digest("hex");
}

/** 1-based inclusive extraction; CRLF normalized to LF. */
export function extractAnchoredText(
  fileContent: string,
  startLine: number,
  endLine: number,
): string {
  return fileContent.split(/\r?\n/)
                    .slice(startLine - 1, endLine)
                    .join("\n");
}

export interface AnchorRange {
  file: string;
  startLine: number;
  endLine: number;
}

export type AnchorVerification =
  | { ok: true; snippetHash: string }
  | { ok: false; errors: [string, ...string[]] };

export function verifyAnchor(
  anchor: AnchorRange,
  fileContent: string,
): AnchorVerification {
  const lineCount = fileContent.split(/\r?\n/).length;
  const errors: string[] = [];

  if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1) {
    errors.push(
      `${anchor.file}: startLine must be an integer >= 1 (got ${anchor.startLine})`,
    );
  }
  if (!Number.isInteger(anchor.endLine) || anchor.endLine < 1) {
    errors.push(
      `${anchor.file}: endLine must be an integer >= 1 (got ${anchor.endLine})`,
    );
  } else if (
    Number.isInteger(anchor.startLine)
    && anchor.endLine < anchor.startLine
  ) {
    errors.push(
      `${anchor.file}: endLine ${anchor.endLine} is before startLine ${anchor.startLine}`,
    );
  }
  if (Number.isInteger(anchor.endLine) && anchor.endLine > lineCount) {
    errors.push(
      `${anchor.file}: endLine ${anchor.endLine} exceeds file length ${lineCount}`,
    );
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors as [string, ...string[]] };
  }
  return {
    ok: true,
    snippetHash: computeSnippetHash(
      extractAnchoredText(fileContent, anchor.startLine, anchor.endLine),
    ),
  };
}

export type AnchorFreshness = "fresh" | "drifted" | "out-of-range";

/** Recompute the anchored snippet's hash and compare to the stored one. Assumes a valid anchor range (parseTour gates that). */
export function checkAnchorFreshness(
  anchor: AnchorRange & { snippetHash: string },
  fileContent: string,
): AnchorFreshness {
  const lineCount = fileContent.split(/\r?\n/).length;
  if (anchor.endLine > lineCount) {
    return "out-of-range";
  }
  const current = computeSnippetHash(
    extractAnchoredText(fileContent, anchor.startLine, anchor.endLine),
  );
  return current === anchor.snippetHash ? "fresh" : "drifted";
}

/** A range the server resolved for a symbol-anchor; undefined when the symbol is gone. */
export interface ResolvedRange {
  startLine: number;
  endLine: number;
}

export type SymbolFreshness =
  | { state: "fresh"; startLine: number; endLine: number; snippetHash: string }
  | {
      state: "relocated";
      startLine: number;
      endLine: number;
      snippetHash: string;
    }
  | { state: "symbol-missing" };

/**
 * Freshness for a symbol-anchor, given the range the server resolved from the
 * code-map. Pure — never touches tree-sitter or fs. `resolved === undefined`
 * means the symbol no longer exists. `relocated` means the cache is stale (the
 * symbol moved and/or its content changed) and the returned fields are the
 * refreshed cache.
 */
export function checkSymbolAnchorFreshness(
  anchor: { startLine: number; endLine: number; snippetHash: string },
  resolved: ResolvedRange | undefined,
  fileContent: string,
): SymbolFreshness {
  if (!resolved) {
    return { state: "symbol-missing" };
  }
  const snippetHash = computeSnippetHash(
    extractAnchoredText(fileContent, resolved.startLine, resolved.endLine),
  );
  const moved = resolved.startLine !== anchor.startLine
                || resolved.endLine !== anchor.endLine;
  const contentChanged = snippetHash !== anchor.snippetHash;
  const state = moved || contentChanged ? "relocated" : "fresh";
  return {
    state,
    startLine: resolved.startLine,
    endLine: resolved.endLine,
    snippetHash,
  };
}

export type ReanchorResult =
  | {
      outcome: "reanchored";
      startLine: number;
      endLine: number;
      snippetHash: string;
    }
  | { outcome: "not-found" }
  | { outcome: "ambiguous" };

/** Search the file for the window (of the anchor's original length) whose hash equals the stored hash. */
export function findReanchor(
  anchor: AnchorRange & { snippetHash: string },
  fileContent: string,
): ReanchorResult {
  const lines = fileContent.split(/\r?\n/);
  const windowLength = anchor.endLine - anchor.startLine + 1;
  if (windowLength < 1 || windowLength > lines.length) {
    return { outcome: "not-found" };
  }
  const matches: { startLine: number; endLine: number }[] = [];
  for (let start = 1; start + windowLength - 1 <= lines.length; start += 1) {
    const end = start + windowLength - 1;
    if (
      computeSnippetHash(lines.slice(start - 1, end).join("\n"))
      === anchor.snippetHash
    ) {
      matches.push({ startLine: start, endLine: end });
    }
  }
  if (matches.length === 0) {
    return { outcome: "not-found" };
  }
  if (matches.length > 1) {
    return { outcome: "ambiguous" };
  }
  return {
    outcome: "reanchored",
    startLine: matches[0].startLine,
    endLine: matches[0].endLine,
    snippetHash: anchor.snippetHash,
  };
}
