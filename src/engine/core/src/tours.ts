import type { Tour, TourSummary } from "@made-i-t/hdtw-protocol";

export type ParseTourResult =
  | { ok: true; tour: Tour }
  | { ok: false; errors: string[] };

export function parseTour(jsonText: string, filenameStem: string): ParseTourResult {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["root must be a JSON object"] };
  }
  const candidate = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (candidate.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    errors.push("id must be a non-empty string");
  } else if (candidate.id !== filenameStem) {
    errors.push(`id "${candidate.id}" must match filename stem "${filenameStem}"`);
  }
  if (typeof candidate.title !== "string" || candidate.title.length === 0) {
    errors.push("title must be a non-empty string");
  }
  if (typeof candidate.summary !== "string") {
    errors.push("summary must be a string");
  }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    candidate.steps.forEach((step, index) => errors.push(...validateStep(step, index)));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, tour: candidate as unknown as Tour };
}

function validateStep(step: unknown, index: number): string[] {
  const label = `steps[${index}]`;
  if (typeof step !== "object" || step === null) {
    return [`${label} must be an object`];
  }
  const candidate = step as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof candidate.title !== "string" || candidate.title.length === 0) {
    errors.push(`${label}.title must be a non-empty string`);
  }
  if (typeof candidate.narration !== "string" || candidate.narration.length === 0) {
    errors.push(`${label}.narration must be a non-empty string`);
  }
  errors.push(...validateAnchor(candidate.anchor, label));
  return errors;
}

function validateAnchor(anchor: unknown, stepLabel: string): string[] {
  const label = `${stepLabel}.anchor`;
  if (typeof anchor !== "object" || anchor === null) {
    return [`${label} must be an object`];
  }
  const candidate = anchor as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof candidate.file !== "string" || candidate.file.length === 0) {
    errors.push(`${label}.file must be a non-empty string`);
  } else if (candidate.file.startsWith("/") || candidate.file.includes("\\")) {
    errors.push(`${label}.file must be a workspace-relative POSIX path`);
  }
  if (!Number.isInteger(candidate.startLine) || (candidate.startLine as number) < 1) {
    errors.push(`${label}.startLine must be an integer >= 1`);
  }
  if (!Number.isInteger(candidate.endLine)) {
    errors.push(`${label}.endLine must be an integer`);
  } else if (
    Number.isInteger(candidate.startLine) &&
    (candidate.endLine as number) < (candidate.startLine as number)
  ) {
    errors.push(`${label}.endLine must be >= startLine`);
  }
  if (
    typeof candidate.snippetHash !== "string" ||
    !candidate.snippetHash.startsWith("sha256:")
  ) {
    errors.push(`${label}.snippetHash must be a string starting with "sha256:"`);
  }
  return errors;
}

export function toTourSummary(tour: Tour): TourSummary {
  return {
    id: tour.id,
    title: tour.title,
    summary: tour.summary,
    stepCount: tour.steps.length,
  };
}

export function toErrorSummary(filenameStem: string, errors: string[]): TourSummary {
  return {
    id: filenameStem,
    title: filenameStem,
    summary: "",
    stepCount: 0,
    error: errors.join("; "),
  };
}
