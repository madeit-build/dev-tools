# `@madeit-build/workspace`: one answer to "which project is this work about"

**Status:** approved
**Date:** 2026-11-25
**Home:** `src/workspace/` in this repo; consumed by hookd (agent-utilities) and the side-quest caretaker (box.provisioning)
**Follows:** [Anatomy of a shared package](../adrs/2026-11-25-anatomy-of-a-shared-package.md)

## The problem

On 2026-11-24 a side quest was filed as "Captured while working in
gufo-v0.35.0 on branch HEAD". The session was a box.provisioning session. The
note command happened to run with its working directory inside a scratch clone
of an upstream repo, checked out at a tag. Every word of the line was true and
none of it was useful. The nightly caretaker, given a folder name that matched
no repo, picked one itself and researched the wrong codebase.

That line came from one of three resolvers in hookd, each answering the same
question differently:

| Where (agent-utilities, `src/claude/hookd/ts`) | How it decides |
|---|---|
| `nudge/ledger.ts` `repoName()` | git common dir, else folder name |
| `cues/engine.ts` `projectOf()` | folder name of the cwd |
| `cues/store/project.ts` `projectCandidates()` | walks path segments, strips `-worktrees`, matches the memory store |

None looks at the git remote. None knows which project the session started
in. A fourth answer is a hardcoded `repo:` string in hookd's loggers.

## Intent

One function, with our priority order written down once, that says which
project a piece of work is about, how it knows, and what else it saw. Its
output is consistent wherever it is shown, and a reader of that output (a
person or the caretaker) can tell a confident answer from a fallback.

## Goals

- A resolver that returns a pick, the category of evidence behind it, and
  every layer it considered.
- One display line, generated in one place, for notes and cards.
- A machine-readable form of the same answer on each card, so the caretaker
  stops guessing.
- The 2026-11-24 case resolves to box.provisioning.

## Non-goals

- Replacing `cues/engine.ts` `projectOf()` or `cues/store/project.ts`. Cues
  run on every hook and the second one maps to the memory store's own project
  names. Each is its own change, after this package has a measured cost.
- Replacing the hardcoded `repo:` in hookd's loggers.
- A Python or .NET port. No consumer in those languages exists yet.
- Session lookup for harnesses other than Claude Code. The resolver takes the
  session directory as plain input, so another harness can supply its own.
- Acting on a project change mid-session (side-quests#330).

## Anti-goals

- **A confident wrong answer.** A fallback that looks like a real answer is the
  bug being fixed. A folder-name result must say it is one.
- **A resolver that can break its caller.** It never throws and never blocks
  on a prompt. The worst case is the folder name, labeled as such.
- **Local paths or remote URLs on a card.** Cards are GitHub issues.

## Approaches considered

1. **A shared package in dev-tools (chosen).** A TypeScript library, a CLI that
   prints the same result as JSON, and a cases file as the contract. hookd
   imports the library; the caretaker takes it through the pinned dev-tools
   input, as it does the log package.
2. **A module inside hookd.** Fixes the card with the least glue. Rejected: the
   caretaker has to read what hookd writes, so the format would live in two
   repos with nothing holding them together, and the next tool copies it.
3. **A CLI only.** One implementation for any language. Rejected: about 14 ms
   per process start (`src/log/README.md`, "Measured costs"), and hookd is the
   first consumer.

Matt picked 1, and widened it from a single-purpose `project` package to a
`workspace` domain package with subpath exports. The ADR above records why.

## The decision rule

The resolver looks at two places: the working directory, and the directory
the session started in when the caller supplies one. For each it collects the
same facts.

**Facts about a directory:**

| Fact | From |
|---|---|
| `origin` | owner and name parsed from `remote.origin.url` |
| `repoFolder` | folder holding the common git dir, so a worktree reports its repo |
| `folder` | the directory's own basename |
| `ref` | branch; on a detached HEAD the exact tag, else the short commit id |
| `ours` | `true` when `origin`'s owner is the configured org, `false` when it is another owner, `null` when there is no origin |

A directory's **name** is the first of these that exists: `origin` name,
`repoFolder`, `folder`. Its **source** is which one that was: `origin`,
`git-common-dir`, or `folder`. A repo that is not ours is named
`owner/name`, never the bare name, so it cannot read like one of ours.

**Picking the headline:**

1. The cwd is in a repo that is ours: the cwd wins. The work is about that
   repo even if the session started somewhere else.
2. Otherwise, a session directory was supplied and is inside a git repo: the
   session wins, with source `session`. The cwd is reported as context.
3. Otherwise the cwd wins, with whatever source it has.

A session directory that is a plain folder never wins. Sessions do start in
umbrella folders that hold several repos, and picking that folder's name with
the label `session` would be a fallback dressed as an answer. It is recorded
as a layer and the cwd is judged alone.

When the session wins and the cwd is somewhere else, `context` describes the
cwd. When the cwd and the session are the same repo, there is no context.

The configured org defaults to `madeit-build` and is an input, not a constant
buried in the function.

## The interface

```ts
// @madeit-build/workspace/project
type Source = "origin" | "git-common-dir" | "folder" | "session";
type RefKind = "branch" | "tag" | "commit";

type ProjectResolution = {
  schema: "madeit-workspace-project-v1";
  project: string;                 // the pick, e.g. "box.provisioning"
  source: Source;                  // the category of evidence behind the pick
  sessionSource: "origin" | "git-common-dir" | null; // what named a session pick
  ours: boolean | null;
  ref: string | null;              // the pick's ref, e.g. "main"
  refKind: RefKind | null;
  context: {                       // where the cwd was, when it is not the pick
    project: string;               // "gufo-org/gufo" for a foreign origin
    source: Exclude<Source, "session">;
    ref: string | null;
    refKind: RefKind | null;
  } | null;
  layers: Layer[];                 // everything considered, in the order tried
  display: string;
};

type Layer = {
  where: "cwd" | "session";
  source: Exclude<Source, "session">;
  outcome: "used" | "available" | "absent" | "failed";
  value: string | null;
  detail: string;                  // what was found, or what failed and what to try
};

function resolveProject(input: {
  cwd: string;
  sessionDir?: string | null;
  org?: string;
}): ProjectResolution;

function toCardLine(resolution: ProjectResolution): string;
function fromCardLine(text: string): CardProject | null;
```

```ts
// @madeit-build/workspace/session
function claudeCodeSessionDir(input: {
  sessionId?: string;              // defaults to CLAUDE_CODE_SESSION_ID
  transcriptPath?: string;         // a hook payload's transcript_path, when the caller has one
  home?: string;
}): { dir: string | null; detail: string };
```

`resolveProject` is synchronous, because hookd's note path is. It is split
into a pure `decide(facts)` and a probe that collects the facts, so the rule is
tested without git and the probe is tested against real repositories.

### The display line

Generated only by this package. The forms:

| Situation | `display` |
|---|---|
| cwd in one of our repos | `box.provisioning on branch main` |
| a worktree of one of our repos | `box.provisioning on branch fix/caretaker-scrub-paths` |
| session wins, cwd elsewhere | `box.provisioning on branch main, while inside a clone of gufo-org/gufo at tag v0.35.0` |
| detached at a commit | `seaboard at commit 73c96da` |
| a repo with no remote | `scratch-idea on branch main (a local repo with no remote)` |
| a repo that is not ours, no session | `gufo-org/gufo at tag v0.35.0 (not one of ours)` |
| session wins, cwd in a local repo | `box.provisioning on branch main, while inside scratch-idea, a local repo with no remote` |
| session wins, cwd a plain folder | `box.provisioning on branch main, while inside the folder Downloads` |
| not a git repo, no session | `Downloads (a folder, not a git repo)` |

### The card line

`toCardLine` produces one HTML comment that holds the compact form: `schema`,
`project`, `source`, `ours`, `ref`, `refKind`, `context`. No `layers`, no
paths, no URLs. `fromCardLine` finds and validates it in a card body and
returns `null` for anything that does not validate. Both ends use these two
functions, so the format has one implementation.

### The CLI

`madeit-workspace project [--cwd DIR] [--session-dir DIR]` prints the full
resolution as JSON, layers included. It is the answer to "why did it say
that". `madeit-workspace doctor` checks, in the order they are most likely to
be wrong: `git` is on `PATH`; the cwd is readable; a session id is in the
environment; that session's transcript is found and has a start directory;
the cwd's origin parses. Each failed check says what to try next.

## Security

- **Identity:** the calling process's own user. The package has no privileges
  of its own and opens no network connection.
- **Authentication:** none.
- **Authorization:** whatever the caller can already read.

**What it reads.** Git metadata for two directories, and for the session
lookup one transcript file under the user's Claude Code data directory. From
the transcript it takes the `cwd` field of the first row that has one, reads
no more than the first 64 KiB, and keeps nothing else.

**What it executes.** `git`, as an argv array with `-C`, never a shell, with a
timeout, terminal prompts off, and system config ignored. The working
directory is often an untrusted clone, which is the case this package exists
for, so it is limited to commands that read refs and config: `rev-parse`,
`symbolic-ref`, `describe`, and `config --get`. It never runs a command that
reads the working tree, because those can run a program a repo's config
names.

**What it must never emit.**

- A remote URL. An origin URL can carry a credential
  (`https://user:token@host/...`). The parser extracts owner and name and
  discards the rest; a URL it cannot parse becomes a failed layer whose detail
  does not quote it.
- An absolute path, in `display` or in the card line. `layers` may carry
  paths, because they stay on the machine; the card line is built from the
  compact form and cannot.
- A session id or any transcript content.

Everything on a card is untrusted when the caretaker reads it back.
`fromCardLine` validates against the schema, and the caretaker accepts a
card's project only when all three hold: `ours` is true, the name was not a
folder name (`source` is `origin`, or `session` with `sessionSource` of
`origin`), and the project is one of the repos it mirrors. A fork with one of
our repo names, or a folder that happens to share one, fails the first two.

## Observability

Per the ADR, the library returns its evidence and does not log. `layers` is
that evidence: one entry per source tried in each place, with what was found
or what failed and what to try.

- **hookd** logs the resolution on `side-quest.noted`: `madeit.project`,
  `madeit.project_source`, and `madeit.project_context` when there is one. A
  note whose pick came from `folder`, or whose session lookup failed, logs at
  `warn` with the failed layers' details.
- **The caretaker** logs, per card, whether a card line was found, whether it
  validated, and whether its project is a mirrored repo. "The card named a
  project we do not mirror" is a distinct event from "the card had no line".
- **A person** runs `madeit-workspace project` in the directory in question.

## Packaging

Per the ADR:

- `src/workspace/src/core`: the package, ESM, `exports` for `./project` and
  `./session`, `sideEffects: false`, a `madeit-workspace` bin, Node 22 or
  later. No runtime dependencies, so it is **shallow**.
- `src/workspace/schema/madeit-workspace-project-v1.json` and
  `src/workspace/schema/project-cases.json`.
- A README that opens with the scope sentence: this package answers questions
  about where work is happening, and nothing else.
- Published to GitHub Packages, and buildable from source at any commit on
  `main`.

## How it is proved

**The cases file** drives `decide(facts)` and is the contract a later port must
pass. At minimum:

| Case | Pick | Source | Context |
|---|---|---|---|
| cwd in our repo, no session | repo name | `origin` | none |
| cwd in a worktree of our repo | repo name | `origin` | none |
| cwd in our repo, session in a different one of ours | cwd's repo | `origin` | none |
| cwd in a foreign clone at a tag, session in our repo | session's repo | `session` | `owner/name` at the tag |
| cwd in a foreign clone, no session | `owner/name` | `origin`, `ours: false` | none |
| cwd in a foreign clone, session in a plain folder | `owner/name` | `origin`, `ours: false` | none, with the session folder as an available layer |
| cwd in a foreign clone, session in a different foreign clone | session's `owner/name` | `session`, `ours: false` | the cwd's `owner/name` |
| cwd in a repo with no remote, session in our repo | session's repo | `session` | the local repo |
| cwd in a repo with no remote, no session | repo folder | `git-common-dir` | none |
| cwd not a git repo, session in our repo | session's repo | `session` | the folder |
| cwd not a git repo, no session | folder | `folder` | none |
| cwd and session are the same repo | repo name | `origin` | none |
| session directory supplied but no longer exists | falls to rule 3 | cwd's | none, with a failed session layer |

**Probe tests** build real repositories in a temp directory: a worktree, a
detached tag, a detached commit, a foreign origin, no remote, not a repo, an
origin URL carrying a credential (which must not appear anywhere in the
result), and each common origin URL form (`https`, `git@host:`, `ssh://`,
with and without `.git`).

**Card line tests:** `fromCardLine(toCardLine(x))` round-trips; a card line
never contains a path separator followed by a home directory or a URL scheme;
a malformed or oversized comment returns `null`.

**In the consumers:** hookd's note tests show the 2026-11-24 case producing
the session-wins display line. hookd's dependency-walk test still passes with
the package added. The caretaker's tests show a card line naming a mirrored
repo reaching the model as the card's project, and one naming an unmirrored
repo being logged and ignored.

## The consumers, in order

1. **dev-tools:** the package, its schema and cases, its README, and its
   publish path.
2. **agent-utilities (hookd):** `nudge/ledger.ts` records the resolution on
   each note in place of `repoName()` and `currentBranch()`; `nudge/board.ts`
   `boardBody()` writes `Captured while working in <display>.` and the card
   line. The note command gets its session directory from
   `claudeCodeSessionDir()`.
3. **box.provisioning (caretaker):** the package arrives through the pinned
   dev-tools input, the way the log library does. Its derivation's check
   phase runs the package's whole test suite, with `git` as a check input, so
   a bad commit on `main` fails the fleet's build; the log library's
   derivation only checks an import, and this one does not copy that.
   `renderCard` reads the card line and, when the trust rule under Security
   passes, adds one line naming the card's project. The nightly prompt's "may
   name the folder it was captured in" warning stays, because cards filed
   before this have no card line.
4. **box.provisioning (the CLI):** a `madeit-workspace` derivation beside the
   log CLI's, on the fleet hosts and in the Mac toolchain. Without it nothing
   puts the command on a `PATH`, and the doctor is not shipped.

Existing cards have no card line and keep today's behavior.

One reader changes meaning. The ledger's `repo` field becomes the pick, and
`nix/observability/fleet/publish.ts` in box.provisioning publishes that field
on the bus. It moves from "the folder the note ran in" to "the project the
work is about", which is what that consumer wanted all along.

## Left to the builder

- Internal module layout of the package and the names of private helpers.
- The exact wording of each `detail` string, within "what failed and what to
  try".
- Whether the publish workflow is a copy of `publish-log.yml` or both become
  callers of one shared workflow. The second is preferred if it does not
  change how log is published.
- The ledger's field names for the stored resolution, as long as old rows
  still read.

## Round trips to reality

Five, none of which can be settled from the desk:

1. **The pnpm hash.** box.provisioning builds the log library with a pinned
   pnpm dependency hash. Whether adding a workspace package to this repo's
   lockfile changes that hash decides whether merging step 1 breaks the fleet's
   next flake bump. Build box.provisioning's log library against the branch
   before merging it.
2. **The first publish** to GitHub Packages, and whether the workflow's
   registry-derived version does what a first release needs.
3. **hookd installing it** from the registry.
4. **The caretaker and the CLI building** on vik through the dev-tools input,
   each with its own pinned hash, and the test suite passing inside the Nix
   sandbox with no network.
5. **One nightly run** reading a card filed after step 2 has shipped.

Two need Matt: a registry token with `read:packages` if step 3's install
cannot authenticate, and a look at the first real card after step 5.

## Success criteria

- Re-running the 2026-11-24 note from the same directory, in a
  box.provisioning session, files a card that says box.provisioning and names
  the gufo clone as context.
- A note taken in a worktree names the repo, not the worktree folder.
- No card contains an absolute path or a remote URL.
- The caretaker's notes on a card filed after this ships are about the repo
  the card line names.
- `madeit-workspace project` explains any of the above without a code change.
