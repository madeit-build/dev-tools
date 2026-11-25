import fs from "node:fs";
import path from "node:path";

export type SessionDir = { dir: string | null; detail: string };

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// The start directory sits in the first few rows; a bounded read keeps a large transcript out of memory.
const READ_LIMIT_BYTES = 65536;

const none = (detail: string): SessionDir => ({ dir: null, detail });

function findTranscript(claudeDir: string, sessionId: string): string | SessionDir {
  const projects = path.join(claudeDir, "projects");
  let folders: string[];
  try {
    folders = fs.readdirSync(projects);
  } catch {
    return none("the Claude Code projects folder could not be read; set CLAUDE_CONFIG_DIR if it is not under the home directory");
  }
  const file = folders.map((folder) => path.join(projects, folder, `${sessionId}.jsonl`)).find((each) => fs.existsSync(each));
  return file ?? none("no transcript was found for this session; it may belong to another machine or have been cleared");
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
    return read < READ_LIMIT_BYTES ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  } catch {
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function firstCwd(head: string): string | null {
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown } | null)?.cwd;
      if (typeof cwd === "string" && path.isAbsolute(cwd)) return cwd;
    } catch {
      continue;
    }
  }
  return null;
}

function transcriptFor(input: { sessionId?: string; transcriptPath?: string; claudeDir?: string }): string | SessionDir {
  if (input.transcriptPath) return input.transcriptPath;
  const sessionId = input.sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? "";
  if (sessionId === "") return none("no session id; CLAUDE_CODE_SESSION_ID is unset, so pass --session-dir");
  if (!SESSION_ID.test(sessionId)) return none("the value given is not a session id; pass --session-dir");
  const claudeDir = input.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude");
  return findTranscript(claudeDir, sessionId);
}

// Reads one field of one row. Nothing else from the transcript, and never the session id, leaves this function.
export function claudeCodeSessionDir(
  input: { sessionId?: string; transcriptPath?: string; claudeDir?: string } = {},
): SessionDir {
  try {
    const transcript = transcriptFor(input);
    if (typeof transcript !== "string") return transcript;
    const head = readHead(transcript);
    if (head === null) return none("the session's transcript could not be read; pass --session-dir");
    const dir = firstCwd(head);
    return dir === null
      ? none("the transcript's first rows name no start directory; pass --session-dir")
      : { dir, detail: "the directory the session's transcript starts in" };
  } catch {
    return none("the session lookup failed unexpectedly; pass --session-dir");
  }
}
