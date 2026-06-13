import { createHash } from "node:crypto";

/** Canonical snippet hash: sha256 over the anchored lines joined with "\n". */
export function computeSnippetHash(anchoredText: string): string {
  return "sha256:" + createHash("sha256").update(anchoredText).digest("hex");
}

/** 1-based inclusive extraction; CRLF normalized to LF. */
export function extractAnchoredText(
  fileContent: string,
  startLine: number,
  endLine: number
): string {
  return fileContent
    .split(/\r?\n/)
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

export function verifyAnchor(anchor: AnchorRange, fileContent: string): AnchorVerification {
  const lineCount = fileContent.split(/\r?\n/).length;
  const errors: string[] = [];

  if (!Number.isInteger(anchor.startLine) || anchor.startLine < 1) {
    errors.push(`${anchor.file}: startLine must be an integer >= 1 (got ${anchor.startLine})`);
  }
  if (!Number.isInteger(anchor.endLine) || anchor.endLine < 1) {
    errors.push(`${anchor.file}: endLine must be an integer >= 1 (got ${anchor.endLine})`);
  } else if (Number.isInteger(anchor.startLine) && anchor.endLine < anchor.startLine) {
    errors.push(`${anchor.file}: endLine ${anchor.endLine} is before startLine ${anchor.startLine}`);
  }
  if (Number.isInteger(anchor.endLine) && anchor.endLine > lineCount) {
    errors.push(`${anchor.file}: endLine ${anchor.endLine} exceeds file length ${lineCount}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors as [string, ...string[]] };
  }
  return {
    ok: true,
    snippetHash: computeSnippetHash(
      extractAnchoredText(fileContent, anchor.startLine, anchor.endLine)
    ),
  };
}
