import fs from "node:fs";
import path from "node:path";

export type SessionDir = { dir: string | null; detail: string };

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// The start directory sits in the first few rows; a bounded read keeps a large transcript out of memory.
const READ_LIMIT_BYTES = 65536;

const none = (detail: string): SessionDir => ({ dir: null, detail });

function findTranscript(
  claudeDir: string,
  sessionId: string,
): string | SessionDir {
  const projects = path.join(claudeDir, "projects");
  let folders: string[];
  try {
    folders = fs.readdirSync(projects);
  } catch {
    return none(
      "the Claude Code projects folder could not be read; set CLAUDE_CONFIG_DIR if it is not under the home directory",
    );
  }
  const file = folders.map((folder) => path.join(projects, folder, `${sessionId}.jsonl`))
                      .find((each) => fs.existsSync(each));
  return (
    file
    ?? none(
      "no transcript was found for this session; it may belong to another machine or have been cleared",
    )
  );
}

function readHead(file: string): string | null {
  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(READ_LIMIT_BYTES);
    const read = fs.readSync(handle, buffer, 0, READ_LIMIT_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    // A read that filled the buffer probably cut a row in half; that row is dropped, not parsed.
    return read < READ_LIMIT_BYTES
      ? text
      : text.slice(0, text.lastIndexOf("\n") + 1);
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

// A row stamped with another session's id is not evidence about this one. Whether the directory
// still exists is the resolver's question: a directory that does not can never win there.
function firstCwd(head: string, sessionId: string | null): string | null {
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as {
        cwd?: unknown;
        sessionId?: unknown;
      } | null;
      const foreign = sessionId !== null
                      && typeof row?.sessionId === "string"
                      && row.sessionId !== sessionId;
      if (!foreign && typeof row?.cwd === "string" && path.isAbsolute(row.cwd))
        return row.cwd;
    } catch {
      continue;
    }
  }
  return null;
}

type Transcript = { file: string; sessionId: string | null };

function transcriptFor(input: {
  sessionId?: string;
  transcriptPath?: string;
  claudeDir?: string;
}): Transcript | SessionDir {
  if (input.transcriptPath)
    return { file: input.transcriptPath, sessionId: null };
  const sessionId = input.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (sessionId === "")
    return none(
      "no session id; CLAUDE_CODE_SESSION_ID is unset, so pass --session-dir",
    );
  if (!SESSION_ID.test(sessionId))
    return none("the value given is not a session id; pass --session-dir");
  const claudeDir = input.claudeDir
                    ?? process.env.CLAUDE_CONFIG_DIR
                    ?? path.join(process.env.HOME ?? "", ".claude");
  const found = findTranscript(claudeDir, sessionId);
  return typeof found === "string" ? { file: found, sessionId } : found;
}

// Reads one field of one row. Nothing else from the transcript, and never the session id, leaves this function.
export function claudeCodeSessionDir(
  input: {
    sessionId?: string;
    transcriptPath?: string;
    claudeDir?: string;
  } = {},
): SessionDir {
  try {
    const transcript = transcriptFor(input);
    if ("detail" in transcript) return transcript;
    const head = readHead(transcript.file);
    if (head === null)
      return none(
        "the session's transcript could not be read; pass --session-dir",
      );
    const dir = firstCwd(head, transcript.sessionId);
    return dir === null
      ? none(
          "the transcript's first rows name no start directory; pass --session-dir",
        )
      : { dir, detail: "the directory the session's transcript starts in" };
  } catch {
    return none("the session lookup failed unexpectedly; pass --session-dir");
  }
}
