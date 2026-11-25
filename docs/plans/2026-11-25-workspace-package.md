# `@madeit-build/workspace` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `@madeit-build/workspace` package in dev-tools: a resolver that says which project a piece of work is about, how it knows, and what else it saw, with a CLI that explains the answer.

**Architecture:** A pure `decide(facts)` holds the priority rule and is driven by a shared cases file. A probe collects the facts by running five read-only `git` commands. `resolveProject` joins them and never throws. The card line, the Claude Code session lookup, and the CLI sit on top.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 22 or later, vitest, ajv for schema tests. No runtime dependencies.

**Spec:** `docs/specs/2026-11-25-workspace-package-design.md`. Read it with `docs/adrs/2026-11-25-anatomy-of-a-shared-package.md`.

**This plan covers consumer step 1 of the spec only.** hookd, the caretaker, and the CLI's Nix derivation each get their own plan after this package is published, because each depends on something only the publish can show.

## Global Constraints

- Package directory: `src/workspace/src/core`. Schema directory: `src/workspace/schema`. Mirror `src/log/src/core` for `tsconfig.json`, `tsconfig.build.json`, scripts, and test placement (`*.test.ts` beside the source).
- `package.json`: name `@madeit-build/workspace`, `"type": "module"`, `"sideEffects": false`, `"engines": { "node": ">=22" }`, `"files": ["dist"]`, the same `publishConfig` as log, `"bin": { "madeit-workspace": "./dist/cli.js" }`, and `exports` with exactly `./project` and `./session`. No `"."` export. No `dependencies` field.
- Dev dependencies, same versions as log: `ajv`, `vitest`, `typescript`, `@types/node`.
- Schema id and the `schema` field value: `madeit-workspace-project-v1`.
- Default org: `madeit-build`. Owner comparison is case-insensitive.
- `git` runs only through one runner: `execFileSync("git", ["-C", dir, ...args])`, no shell, timeout 2000 ms, stderr ignored, env adds `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_NOSYSTEM=1`.
- Only these five argument lists may reach the runner. Each was run on 2026-11-25 against a foreign clone at a tag, a worktree, a plain folder, and a repo with no commits:
  - `rev-parse --path-format=absolute --git-common-dir`
  - `symbolic-ref --quiet --short HEAD`
  - `describe --tags --exact-match HEAD`
  - `rev-parse --short HEAD`
  - `config --get remote.origin.url`
- No function in the package throws to its caller, logs, or writes to stdout or stderr. The CLI is the only writer.
- A remote URL never appears in any return value, `detail` string, or error. An absolute path never appears in `display` or in a card line.
- Run commands from the repo root: `pnpm --filter @madeit-build/workspace <script>`.
- Comments explain why, two sentences at most. American English.

## Review Focus

Inputs the spec implies but does not test, most likely first. Each has a test in the task named.

1. **The cwd no longer exists** (a hook fires after a worktree is removed). Expect the folder's basename, source `folder`, a failed layer, no throw. Task 5.
2. **`git` is missing from `PATH` or times out.** Expect source `folder` and a layer whose detail says to install git or fix `PATH`. Task 4.
3. **A repo with no commits.** `symbolic-ref` succeeds and `rev-parse --short HEAD` exits 128. Expect `ref` to be the branch, `refKind` `branch`. Task 4.
4. **An origin that is not `host/owner/name`:** a local path, or a host with nested groups (`group/sub/name`). Expect nested groups to parse with owner `group/sub`; a local path to yield no origin and a detail that does not quote it. Task 3.
5. **A ref containing `--` or `>`.** Expect the card line to round-trip and to contain `-->` exactly once, at its end. Task 6.

---

### Task 1: Package scaffold, schema, cases file, and `decide`

**Files:**
- Create: `src/workspace/src/core/package.json`, `tsconfig.json`, `tsconfig.build.json`
- Create: `src/workspace/src/core/facts.ts`, `decide.ts`, `decide.test.ts`
- Create: `src/workspace/schema/madeit-workspace-project-v1.json`, `src/workspace/schema/project-cases.json`

**Interfaces:**
- Produces, from `facts.ts`:

```ts
export type RefKind = "branch" | "tag" | "commit";
export type DirectorySource = "origin" | "git-common-dir" | "folder";
export type Source = DirectorySource | "session";

export type DirectoryFacts = {
  path: string;
  exists: boolean;
  folder: string;                                  // basename of path
  commonDir: string | null;                        // absolute; null when not in a git repo
  repoFolder: string | null;                       // basename of commonDir's parent
  origin: { owner: string; name: string } | null;
  ref: string | null;
  refKind: RefKind | null;
  failures: string[];                              // one sentence each: what failed, what to try
};

export type Layer = {
  where: "cwd" | "session";
  source: DirectorySource;
  outcome: "used" | "available" | "absent" | "failed";
  value: string | null;
  detail: string;
};

export type ProjectContext = {
  project: string; source: DirectorySource; ref: string | null; refKind: RefKind | null;
};

export type ProjectResolution = {
  schema: "madeit-workspace-project-v1";
  project: string;
  source: Source;
  sessionSource: "origin" | "git-common-dir" | null;
  ours: boolean | null;
  ref: string | null;
  refKind: RefKind | null;
  context: ProjectContext | null;
  layers: Layer[];
  display: string;
};
```

- Produces, from `decide.ts`: `decide(input: { cwd: DirectoryFacts; session: DirectoryFacts | null; org: string }): Omit<ProjectResolution, "display">`

- [ ] **Step 1: Scaffold the package.** Copy log's `tsconfig.json` and `tsconfig.build.json` unchanged. Write `package.json` per Global Constraints, with log's `scripts`. Run `pnpm install` from the root and confirm `pnpm --filter @madeit-build/workspace typecheck` exits 0 on an empty `facts.ts`.

- [ ] **Step 2: Write `project-cases.json`.** An array of `{ name, org, cwd, session, expect }`, where `cwd` and `session` are `DirectoryFacts` (or `null`) and `expect` holds `project`, `source`, `sessionSource`, `ours`, `ref`, `refKind`, `context`, `display`. One entry per row of the spec's cases table (13 rows) plus one per row of its display table that the cases table does not already cover. Use these names for the two repos throughout: ours is `madeit-build/box.provisioning` on branch `main`; foreign is `gufo-org/gufo` at tag `v0.35.0`.

- [ ] **Step 3: Write the schema.** JSON Schema 2020-12 for `ProjectResolution`, `additionalProperties: false`, all ten properties required.

- [ ] **Step 4: Write the failing test** in `decide.test.ts`:

```ts
const cases = JSON.parse(fs.readFileSync(new URL("../../schema/project-cases.json", import.meta.url), "utf8"));
for (const c of cases) {
  it(c.name, () => {
    const got = decide({ cwd: c.cwd, session: c.session, org: c.org });
    const { display: _display, ...want } = c.expect;
    expect({ ...got, layers: undefined }).toEqual({ schema: "madeit-workspace-project-v1", ...want, layers: undefined });
  });
}
it("marks exactly one layer used, and it names the pick", () => { /* every case */ });
it("records a plain-folder session as available, never used", () => { /* the two plain-folder-session cases */ });
```

- [ ] **Step 5: Run it.** `pnpm --filter @madeit-build/workspace test`. Expected: FAIL, `decide` is not exported.

- [ ] **Step 6: Implement `decide`.** The rule, in order:
  1. A directory's name is `origin.name` when ours, `owner/name` when the origin is another owner, else `repoFolder`, else `folder`. `ours` is `true`, `false`, or `null` with no origin.
  2. `cwd` ours: the cwd wins.
  3. Else `session` is not null and `session.commonDir` is not null: the session wins. `source` is `session`; `sessionSource` is `origin` or `git-common-dir`. `context` is the cwd's name, source, and ref, or `null` when the two share a `commonDir` or an origin.
  4. Else the cwd wins.
  The pick's `ref` and `refKind` come from whichever directory won. Emit one layer per `DirectorySource` per place considered, in the order `origin`, `git-common-dir`, `folder`, cwd first; each of a directory's `failures` becomes a `failed` layer's detail.

- [ ] **Step 7: Run it.** Expected: PASS, all cases.

- [ ] **Step 8: Commit.** `feat(workspace): the project decision rule, its schema, and its cases`

---

### Task 2: The display line

**Files:**
- Create: `src/workspace/src/core/display.ts`, `display.test.ts`

**Interfaces:**
- Consumes: `ProjectResolution` minus `display`, from Task 1.
- Produces: `displayLine(resolution: Omit<ProjectResolution, "display">): string`

- [ ] **Step 1: Write the failing test.** For every case in `project-cases.json`: `expect(displayLine(decide(...))).toBe(c.expect.display)`. Plus: `it("never contains a path separator at the start of a word", ...)` asserting no case's display matches `/(^|\s)\//`.

- [ ] **Step 2: Run it.** Expected: FAIL, `displayLine` is not exported.

- [ ] **Step 3: Implement `displayLine`.** The exact strings are the spec's display table. Ref phrasing: `on branch X`, `at tag X`, `at commit X`, and nothing when `ref` is null. Suffixes: ` (not one of ours)` when `ours` is false and the cwd won; ` (a local repo with no remote)` when source is `git-common-dir`; ` (a folder, not a git repo)` when source is `folder`. Context phrasing: `, while inside a clone of <project> <ref phrase>` for an origin context; `, while inside <project>, a local repo with no remote`; `, while inside the folder <project>`.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): one display line for every resolution`

---

### Task 3: Parsing an origin URL without leaking it

**Files:**
- Create: `src/workspace/src/core/origin.ts`, `origin.test.ts`

**Interfaces:**
- Produces: `parseOrigin(url: string): { owner: string; name: string } | null`

- [ ] **Step 1: Write the failing tests.**

```ts
it.each([
  ["https://github.com/madeit-build/dev-tools.git", "madeit-build", "dev-tools"],
  ["https://github.com/gufo-org/gufo", "gufo-org", "gufo"],
  ["git@github.com:madeit-build/box.provisioning.git", "madeit-build", "box.provisioning"],
  ["ssh://git@github.com/madeit-build/seaboard.git", "madeit-build", "seaboard"],
  ["https://someuser:s3cr3tvalue@github.com/madeit-build/example.git", "madeit-build", "example"],
  ["https://gitlab.example.com/group/sub/name.git", "group/sub", "name"],
  ["https://github.com/madeit-build/dev-tools/", "madeit-build", "dev-tools"],
])("parses %s", (url, owner, name) => expect(parseOrigin(url)).toEqual({ owner, name }));

it.each(["/srv/git/thing.git", "../sibling", "", "https://github.com/onlyowner", "not a url"])(
  "returns null for %s", (url) => expect(parseOrigin(url)).toBeNull());

it("drops a credential", () =>
  expect(JSON.stringify(parseOrigin("https://someuser:s3cr3tvalue@github.com/a/b.git"))).not.toContain("s3cr3tvalue"));
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement `parseOrigin`.** Use `new URL()` for scheme URLs and one anchored pattern for the `user@host:path` form; split the path on `/`, strip one trailing `.git`. `name` is the last segment, `owner` is the rest joined by `/`. Fewer than two segments is `null`.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): parse an origin to owner and name, and keep nothing else`

---

### Task 4: The git probe

**Files:**
- Create: `src/workspace/src/core/probe.ts`, `probe.test.ts`

**Interfaces:**
- Consumes: `DirectoryFacts` (Task 1), `parseOrigin` (Task 3).
- Produces:

```ts
export type GitRun = (dir: string, args: readonly string[]) => { code: number; stdout: string };
export const runGit: GitRun;                       // the real runner; code -1 when git cannot start or times out
export function probeDirectory(dir: string, run?: GitRun): DirectoryFacts;
```

- [ ] **Step 1: Write the failing tests.** Each builds a real repo under `fs.mkdtempSync(os.tmpdir())` with `git init -b main`, an identity set by `-c`, and `git commit --allow-empty`:

```ts
it("a clone on a branch", ...)            // commonDir set, repoFolder = folder, ref "main", refKind "branch"
it("a worktree reports its repo", ...)    // git worktree add ../wt -b feat; repoFolder is the main checkout's folder
it("a detached tag", ...)                 // git tag v1.2.3 && git checkout --detach v1.2.3; ref "v1.2.3", refKind "tag"
it("a detached commit", ...)              // refKind "commit", ref matches /^[0-9a-f]{7,}$/
it("a repo with no commits", ...)         // ref "main", refKind "branch"
it("a foreign origin", ...)               // remote add origin https://github.com/gufo-org/gufo
it("an origin carrying a credential never surfaces it", ...) // JSON.stringify(facts) lacks "s3cr3tvalue"
it("an unparseable origin is a failure that does not quote it", ...) // origin null; failures has one entry lacking the URL
it("a plain folder", ...)                 // exists true, commonDir null, failures empty
it("a directory that does not exist", ...) // exists false, folder = basename, commonDir null
it("git that cannot start", ...)          // run = () => ({ code: -1, stdout: "" }); failures[0] mentions PATH
it("only ever passes the five allowed argument lists", ...) // a recording run; every call is in the allowed set
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement `runGit` and `probeDirectory`.** Skip every git call when the directory does not exist. Stop after the first call when it returns `-1` (one failure, not five) or a nonzero code (not a repo, which is not a failure). Ref order: `symbolic-ref`, then `describe`, then `rev-parse --short`.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): probe a directory with five read-only git commands`

---

### Task 5: `resolveProject`

**Files:**
- Create: `src/workspace/src/core/project.ts`, `project.test.ts`

**Interfaces:**
- Consumes: `decide`, `displayLine`, `probeDirectory`.
- Produces, and re-exports every type from `facts.ts`:

```ts
export function resolveProject(
  input: { cwd: string; sessionDir?: string | null; org?: string },
  run?: GitRun,
): ProjectResolution;
```

- [ ] **Step 1: Write the failing tests.**

```ts
it("the 2026-11-24 case", ...)   // real temp repos: session = ours on main, cwd = foreign clone detached at v0.35.0;
                                 // display === "box.provisioning on branch main, while inside a clone of gufo-org/gufo at tag v0.35.0"
it("every result validates against the schema", ...)           // ajv over each scenario in this file
it("a cwd that does not exist falls back to its folder name", ...) // source "folder", one failed layer, no throw
it("a session directory that no longer exists is a failed layer and the cwd is judged alone", ...)
it("never throws", ...)          // run = () => { throw new Error("boom") }; returns source "folder"
it("org is an input", ...)       // org "gufo-org" makes the foreign clone ours
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement `resolveProject`.** Probe the cwd, probe the session directory when given, call `decide`, attach `displayLine`. One `try` around the whole body whose fallback is a resolution built from `path.basename(input.cwd)` with a failed layer.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): resolveProject, which never throws`

---

### Task 6: The card line

**Files:**
- Create: `src/workspace/src/core/card.ts`, `card.test.ts`
- Modify: `src/workspace/src/core/project.ts` (re-export)
- Create: `src/workspace/schema/madeit-workspace-card-v1.json`

**Interfaces:**
- Produces:

```ts
export type CardProject = Omit<ProjectResolution, "layers" | "display">;
export function toCardLine(resolution: ProjectResolution): string;
export function fromCardLine(text: string): CardProject | null;
```

The line is exactly `<!-- madeit-workspace-project-v1 ` + JSON + ` -->`. In the JSON text every `--` is written `--` and every `>` as `>`, so nothing inside can close the comment.

- [ ] **Step 1: Write the failing tests.**

```ts
it("round-trips every case", ...)                 // fromCardLine(toCardLine(r)) equals r minus layers and display
it("is found inside a larger card body", ...)     // prose before and after
it("a ref containing --> cannot close the comment", ...) // ref "a-->b": the line contains "-->" once, at its end; round-trips
it("carries no layers and no display", ...)
it.each(["", "<!-- madeit-workspace-project-v1 {not json} -->", "<!-- madeit-workspace-project-v1 {\"schema\":\"x\"} -->"])("returns null for %s", ...)
it("returns null when the comment is over 2048 characters", ...)
it("returns null when a property is extra or missing", ...)
it("takes the first line when a body has two", ...)
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement both functions.** `fromCardLine` validates by hand against the same rules as `madeit-workspace-card-v1.json` (no runtime dependency on ajv); a test asserts the hand validator and ajv agree on every test input.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): a card line both ends read with one implementation`

---

### Task 7: The Claude Code session directory

**Files:**
- Create: `src/workspace/src/core/session.ts`, `session.test.ts`

**Interfaces:**
- Produces:

```ts
export function claudeCodeSessionDir(input?: {
  sessionId?: string;        // default process.env.CLAUDE_CODE_SESSION_ID
  transcriptPath?: string;
  claudeDir?: string;        // default process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude`
}): { dir: string | null; detail: string };
```

A transcript is `<claudeDir>/projects/<any one folder>/<sessionId>.jsonl`. Its start directory is the `cwd` string of the first row that has one. Verified on 2026-11-25 against a live transcript: row 5, byte offset 579.

- [ ] **Step 1: Write the failing tests,** each against a temp `claudeDir`:

```ts
it("finds the first cwd by session id", ...)
it("uses transcriptPath when given and ignores sessionId", ...)
it("returns the first cwd, not a later one", ...)
it("skips rows that are not JSON", ...)
it("null with a detail when no session id is available", ...)
it("null when the session id is not a UUID", ...)        // "../../etc/passwd" never reaches the filesystem
it("null when no transcript matches", ...)
it("null when no row in the first 64 KiB has a cwd", ...) // a 70 KiB first line
it("the detail never contains the session id", ...)
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement it.** Accept a session id only when it matches `/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/`. Find the transcript with `fs.readdirSync` over `projects/`, no glob library. Read at most 65536 bytes with `fs.readSync` and drop a trailing partial line.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): find where a Claude Code session started`

---

### Task 8: The CLI

**Files:**
- Create: `src/workspace/src/core/cli.ts`, `cli.test.ts`, `cli.bin.test.ts`

**Interfaces:**
- Consumes: `resolveProject`, `claudeCodeSessionDir`.
- Produces: `main(argv: string[], io: { out(text: string): void; env: NodeJS.ProcessEnv; cwd: string }): number`

Commands:
- `madeit-workspace project [--cwd DIR] [--session-dir DIR] [--org ORG]` prints the full resolution as indented JSON and returns 0. Without `--session-dir` it calls `claudeCodeSessionDir()`.
- `madeit-workspace doctor [--cwd DIR]` prints one line per check, `ok` or `FAIL` then the check and, on failure, what to try. Returns 1 when any check fails. Checks in this order: `git` starts; the cwd exists and is readable; `CLAUDE_CODE_SESSION_ID` is set; that session's transcript yields a start directory; the cwd's origin parses, or the cwd has none.
- `madeit-workspace --help` and an unknown command print usage; the unknown command returns 2.

- [ ] **Step 1: Write the failing tests.**

```ts
it("project prints a resolution that validates against the schema", ...)
it("project --session-dir overrides the lookup", ...)
it("doctor returns 0 and five ok lines in a healthy repo", ...)
it("doctor returns 1 and says what to try when the session id is unset", ...)
it("doctor never prints a remote URL or a session id", ...)
it("an unknown command returns 2 and prints usage", ...)
// cli.bin.test.ts, after build:
it("dist/cli.js runs under node and prints JSON", ...)
it("the package's exports resolve: ./project and ./session, and nothing else", ...)
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement `main`** with `node:util` `parseArgs`, and a `#!/usr/bin/env node` entry that calls it only when run directly, as log's `cli.ts` does.

- [ ] **Step 4: Run it.** `pnpm --filter @madeit-build/workspace build && pnpm --filter @madeit-build/workspace test`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(workspace): a CLI that explains the answer, and a doctor`

---

### Task 9: README, repo docs, and the publish workflow

**Files:**
- Create: `src/workspace/README.md`
- Create: `.github/workflows/publish-workspace.yml`
- Modify: `AGENTS.md` (the Tools table)

- [ ] **Step 1: Write the README.** First sentence, verbatim: "This package answers questions about where work is happening, and nothing else." Then, in order: the decision rule as the three steps from the spec; the display table; the card line; the CLI; a Security section with the spec's three headings (what it reads, what it executes, what it must never emit); a Dependencies section saying "none, so this package is shallow"; installing, copied from log's README with the name changed.

- [ ] **Step 2: Add the AGENTS.md row.** `| Workspace | \`src/workspace/\` | [\`README.md\`](./src/workspace/README.md) |`

- [ ] **Step 3: Write `publish-workspace.yml`** as a copy of `publish-log.yml` with the name, the concurrency group (`publish-workspace`), the two `paths` entries, and the three `working-directory` values changed to `src/workspace/src/core`, and the path filter widened to `src/workspace/**` so a schema or cases change publishes. Do not extract a shared workflow: `publish-log.yml` lists itself in its own `paths`, so editing it publishes a new log version with no code change.

- [ ] **Step 4: Verify.** `pnpm build && pnpm test && pnpm lint` from the root. Expected: all three exit 0, checked one at a time.

- [ ] **Step 5: Commit.** `docs(workspace): the README, the tools table, and a publish workflow`

---

### Task 10: The round trip before merging

No code. This decides whether merging breaks the fleet's next flake bump.

- [ ] **Step 1:** Push the branch. In a box.provisioning worktree off fresh `origin/main`, run `nix build --no-link "path:$PWD/nix#madeit-log-lib" --override-input dev-tools "github:madeit-build/dev-tools/<branch>"`.
  The attribute name is the one `link-dev-tools.bash` in the caretaker directory uses. The `--override-input` form was not run when this plan was written; confirm it resolves the branch before trusting a green build.
- [ ] **Step 2:** If it builds, the pinned pnpm hash is unaffected: say so in the PR body with the command and its exit status. If it fails with a hash mismatch, stop and report the `got:` value. The merge then needs a paired box.provisioning change, which is a decision for Matt, not a fix to make alone.
- [ ] **Step 3:** Open the PR. Its body lists what was verified and what was not, and names the three consumer plans still to be written.
