# `@madeit-build/workspace`

This package answers questions about where work is happening, and nothing else.

Today that is one question: which project is this piece of work about? It
returns a pick, the kind of evidence behind the pick, and everything else it
looked at, so a reader can tell a confident answer from a fallback.

Design: [`docs/specs/2026-11-25-workspace-package-design.md`](../../docs/specs/2026-11-25-workspace-package-design.md).
Shape of the package: [Anatomy of a shared package](../../docs/adrs/2026-11-25-anatomy-of-a-shared-package.md).

## Installing

The package is published to GitHub Packages under the `@madeit-build` scope, not npm. Point
your `.npmrc` at the scope and authenticate with a token that has `read:packages`.

```
@madeit-build:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```
pnpm add @madeit-build/workspace
```

## Usage

```ts
import {
  resolveProject,
  toCardLine,
  fromCardLine,
} from "@madeit-build/workspace/project";
import { claudeCodeSessionDir } from "@madeit-build/workspace/session";

const resolution = resolveProject({
  cwd: process.cwd(),
  sessionDir: claudeCodeSessionDir().dir,
});
resolution.project; // "box.provisioning"
resolution.source; // "origin" | "git-common-dir" | "folder" | "session"
resolution.display; // "box.provisioning on branch main"
resolution.layers; // every source tried in each place, and what each found
```

`resolveProject` never throws and never logs. Its worst answer is a folder
name, labeled as one. Callers log what they need from `layers`.

## The rule

It looks at two places: the working directory, and the directory the session
started in when the caller supplies one.

1. The working directory is in one of our repos: it wins. The work is about
   that repo even if the session started somewhere else.
2. Otherwise, a session directory was supplied and is inside a git repo: the
   session wins, with source `session`. The working directory is reported as
   `context`.
3. Otherwise the working directory wins, with whatever evidence it has.

A session that started in a plain folder never wins. Its name would be a
fallback labeled as an answer.

A directory is named by the first of these that exists: its origin remote, the
folder that holds its git directory (so a worktree reports its repo), its own
folder name.

**Ours** means the configured org on a known host: `madeit-build` on
`github.com` by default, both inputs (`org`, `hosts`). The owner alone is not
an identity, because anyone can create that owner name on a host of their own.
A repo reached through an ssh host alias (`gh:madeit-build/x`) reads as not ours
until the alias is passed in `hosts`, or to the CLI as `--host gh`.

## The display line

Generated only here, so it reads the same wherever it is shown.

| Situation                                 | `display`                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| in one of our repos, or a worktree of one | `box.provisioning on branch main`                                                       |
| detached at a commit                      | `seaboard at commit 73c96da`                                                            |
| the session wins, the cwd is elsewhere    | `box.provisioning on branch main, while inside a clone of gufo-org/gufo at tag v0.35.0` |
| a repo that is not ours                   | `gufo-org/gufo at tag v0.35.0 (not one of ours)`                                        |
| a repo on a host we do not use            | `git.example.net/madeit-build/box.provisioning on branch main (not one of ours)`        |
| a repo with no remote                     | `scratch-idea on branch main (a local repo with no remote)`                             |
| not a git repo                            | `Downloads (a folder, not a git repo)`                                                  |

The full set, with the facts behind each, is `schema/project-cases.json`.

## The card line

`toCardLine(resolution)` returns one HTML comment holding the compact answer:
everything except `layers` and `display`. `fromCardLine(text)` finds it in a
larger body and returns `null` for anything that does not validate. A writer
and a reader that both use these two functions cannot drift.

Text read back from a card is untrusted. `fromCardLine` proves the shape, not
the truth: a reader still decides whether to believe `ours`.

## The CLI

```
madeit-workspace project [--cwd DIR] [--session-dir DIR] [--org ORG] [--host HOST]...
madeit-workspace doctor [--cwd DIR] [--host HOST]...
```

`project` prints the full resolution as JSON. It is the answer to "why did it
say that". `doctor` checks the things most likely to be wrong, in that order,
says what to try for each failure, and exits 1 if any check fails.

## The contract

`schema/madeit-workspace-project-v1.json` describes a resolution,
`schema/madeit-workspace-card-v1.json` describes the compact form on a card,
and `schema/project-cases.json` holds the decision rule as data: facts in,
expected answer out. A port to another language is done when it passes those
cases.

## Security

**What it reads.** Git metadata for up to two directories. For the session
lookup, one transcript file under Claude Code's data directory: it takes the
`cwd` field of the first row that has one and belongs to this session, reads
at most the first 64 KiB, and keeps nothing else.

**What it executes.** `git`, as an argument array with no shell and a 2 second
timeout. The directory is often an untrusted clone, so two things hold
together:

- The runner refuses everything except five commands that read refs and
  config: two forms of `rev-parse`, `symbolic-ref`, `describe`, and
  `config --get`. None reads the working tree.
- That list limits the arguments, not what git does with them. A repo's own
  config can make even `describe` fetch a missing object and run a program to
  do it. So every call also sets `GIT_NO_LAZY_FETCH=1`, `protocol.allow=never`,
  `safe.bareRepository=explicit` and `core.fsmonitor=false`, turns terminal
  prompts off, ignores system config, and drops every `GIT_*` variable the
  caller had, so a `GIT_DIR` inherited from a git hook cannot redirect it.
  `GIT_NO_LAZY_FETCH` needs git 2.45 or later; `protocol.allow=never` is the
  backstop on older versions.

It opens no network connection itself, and those settings stop git from
opening one.

**What `ours` does and does not mean.** `ours: true` says the repo's own config
names an origin under our org on a known host. A repo's config is whatever its
author wrote, so a hostile clone can claim to be ours. `ours` is good for
choosing which of our own repos to look at. It is not proof of anything, and
nothing should be granted on it.

**What it must never emit.** A remote URL, which can carry a credential: the
parser keeps host, owner and name and drops the rest, and an origin it cannot
read is reported without being quoted. An absolute path in `display` or in a
card line. A session id, or any transcript content. `display` also replaces
control characters and angle brackets in names, so a folder name cannot pose
as markup where the line is shown.

## Dependencies

None, so this package is **shallow**: any consumer may take it, hookd included.

## Developing

From the repo root:

```
pnpm --filter @madeit-build/workspace test
pnpm --filter @madeit-build/workspace typecheck
pnpm --filter @madeit-build/workspace lint
```

The probe tests build real repositories in a temp directory and need `git`.
