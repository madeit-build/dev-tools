// Matches only a token that BEGINS a path - at the start of the string or
// right after whitespace, a quote, or a paren - never a "/" in the middle
// of a token. That distinction is load-bearing: a scoped package name like
// "@made-i-t/hang-prettier" has a slash in the middle and must survive
// intact, while an absolute path (POSIX, a Windows drive path, or a UNC
// share) starts a token and must be fully redacted. Shared by doctor.ts
// (error text and resolved config) and paths.ts (a matched path outside the
// project root) - the two places in this CLI that ever put a filesystem
// path into a message. One function, one place that can leak or fail to.
const POSIX_PATH = /(?<=^|[\s'"(])\/[^\s'")]+/g;
const WINDOWS_DRIVE_PATH = /(?<=^|[\s'"(])[A-Za-z]:\\[^\s'")]+/g;
const UNC_PATH = /(?<=^|[\s'"(])\\\\[^\s'")]+/g;

export function redactPaths(text: string): string {
  return text.replace(POSIX_PATH, "<path>")
             .replace(WINDOWS_DRIVE_PATH, "<path>")
             .replace(UNC_PATH, "<path>");
}
