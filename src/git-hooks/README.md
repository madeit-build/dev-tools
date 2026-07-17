# git-hooks

Git hooks that catch the mistakes agents make quietly. Plain POSIX `sh`, no
build, no dependencies beyond [`gh`](https://cli.github.com).

| Hook | What it does |
| --- | --- |
| [`hooks/pre-push`](./hooks/pre-push) | Refuses to push a branch whose PR is already merged. |

## pre-push: merged-PR guard

An agent opens a PR, the PR gets merged, and the agent keeps committing to the
same branch. Nothing complains. The branch still exists, `git push` succeeds,
and GitHub accepts commits onto a merged PR's head branch without a word. The
PR is closed, so it never picks the commits up: the work is stranded off main
and stays that way until someone notices by eye. The expensive version is a
later branch cut from a main that silently lacks the work, quietly reverting it.

The hook asks `gh` whether the branch being pushed already has a merged PR, and
refuses the push if it does, naming the PR and what to do instead:

```
  Refusing to push: PR #10 for 'feat/box-chat-openwebui' is already MERGED.

  Commits pushed here will not reach the base branch. The merged PR will
  not pick them up, and this work will be silently left behind.

  Cut a fresh branch off an up-to-date main and move the work over:
  ...
```

### Enabling it

`core.hooksPath` points git at a directory of hooks. From this directory:

```bash
git config --global core.hooksPath "$(pwd)/hooks"
```

Drop `--global` to enable it for a single repo.

To scope it to one work area instead of the whole machine, give the work area a
`.gitconfig` that sets `core.hooksPath`, and conditionally include it from
`~/.gitconfig`:

```ini
[includeIf "gitdir/i:~/code/<work-area>/"]
  path = ~/code/<work-area>/.gitconfig
```

Two things worth knowing before setting this globally:

- `core.hooksPath` **replaces** the hooks directory, it does not add to it. A
  repo relying on its own `.git/hooks` stops running them. Point
  `core.hooksPath` at one directory and keep every hook there together.
- A tool that installs hooks by writing into `.git/hooks` (husky, pre-commit,
  lefthook) is silently disabled by it.

Verify it resolved, from inside a repo you expect it to cover:

```bash
git config --get core.hooksPath
```

### Overriding it

For the rare deliberate push to a merged branch:

```bash
ALLOW_MERGED_PR_PUSH=1 git push
```

`git push --no-verify` also works, but it skips every hook, not just this one.
The error message names the variable, so the escape hatch is discoverable at the
moment it is needed.

### It fails open

A global hook that breaks unrelated repos gets uninstalled, so this one is built
to be invisible wherever it does not apply. It exits 0 and stays silent when
there is no `gh`, no auth, no network, no remote, a non-GitHub remote, a
detached HEAD, or the branch is `main` or `master`. A false negative costs
nothing. A false positive blocks real work.

It only spends the `gh` call (roughly 600ms) when the remote looks like GitHub
and the branch could plausibly have a PR. Everything else bails in about 40ms.

Known gap: the check keys off the remote URL, so a URL rewritten by an
`insteadOf` rule to a host that does not look like GitHub skips the check. That
is the safe direction to be wrong in.
