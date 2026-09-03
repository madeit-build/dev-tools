# Design: shell-progress, a shared progress reporter for bash scripts

Date: 2026-07-20
Status: Approved (pending spec review)

## Context

Long-running scripts across Made I.T. go silent during their slowest work.
`box-deploy` is the worst offender: line 105 is a bare `nixos-rebuild switch`,
and a first-time deploy sits there for minutes pulling a multi-GB container image
with no output at all, so the operator cannot tell a working pull from a wedged
one. The same silence shows up anywhere a script shells out to `nix`, `docker`,
`git clone`, or a long health sweep.

The fix is one small, shared reporter every bash script can adopt, rather than
each script growing its own ad-hoc `echo` breadcrumbs. It lives in `dev-tools`
(the public home for shared tooling) as a self-contained bash tool.

### Decisions locked during brainstorming

- **Hybrid interaction model (a library, plus a command wrapper).** A script
  narrates its own *known* phases (`git fetch`, token check), and hands its
  *opaque* long-poles (`nixos-rebuild`) to a wrapper that animates them. A pure
  wrapper cannot see semantic phases; a pure library cannot see inside an opaque
  child. The tool does both.
- **Live-tail in v1.** The wrapper shows the wrapped command's last output line,
  updating live, not just a spinner. A spinner animates whether the child is
  flying or hung; the tail is what actually answers "is the pull moving?", the
  literal pain that motivated this. It is confined to the wrapped-command path,
  so its cost is paid only where it earns its keep.
- **Home: `dev-tools/src/progress`.** Public and discoverable, a self-contained
  bash tool that does not participate in the monorepo's turbo/eslint/tsc.
- **Auto-degrade on non-TTY.** Interactive terminals get the animated checklist;
  a non-TTY (systemd journal, CI, a pipe) gets plain append-only lines and the
  child's native output passing straight through. Never emit ANSI to a non-TTY,
  that is the class of bug that has bitten box-doctor before.
- **Portable to macOS bash 3.2.** The `net` CLI runs on macOS, whose `/bin/bash`
  is 3.2; box scripts run on Linux bash 5. The lib targets 3.2-compatible syntax
  (no associative arrays, no `mapfile`).

## Goals

1. A single sourceable `progress.bash` with a small, stable function API.
2. A rich interactive rendering (phase checklist + spinner + live-tail) that
   auto-degrades to clean plain-text on any non-TTY, from the same script.
3. Adopted by `box-deploy` as the first consumer, with the silent
   `nixos-rebuild` step now live-tailed.
4. Consumable by `box.provisioning` (a separate repo) with a pinned, reproducible
   reference, no vendored drift.

## API

The names follow `common.bash` style (flat, snake_case, descriptive).

- `progress_begin "<title>"` - start a session: record the title and start the
  clock. Sets up the renderer (TTY or plain) once, based on `[ -t 1 ]`.
- `progress_phase "<label>"` - open a manual phase for inline script work. Closes
  the previous phase as done (with its elapsed) if one is open.
- `progress_run "<label>" -- <cmd> [args...]` - open a phase that owns an opaque
  child. Runs `<cmd>`, live-tails its last line, tees its full output to a log,
  closes the phase done/failed by the child's exit code, and **returns that exit
  code** so the caller's `set -e` still applies (but only after the failure is
  rendered with the last ~20 lines of the child's output). `--` separates the
  label from the command so neither can be mistaken for the other.
- `progress_fail "<reason>"` - close the current phase as failed with a reason
  (for manual phases whose failure the script detects itself). Rare.
- `progress_end ["<summary>"]` - close any open phase, print a final summary line
  and total elapsed.

### Example: box-deploy adopting it

```bash
source "${LIB}/progress.bash"
progress_begin "box-deploy"

progress_phase "Fetch main";         git -C "$CHECKOUT" fetch --quiet origin main
progress_phase "Verify deploy token"; check_token_expiry
progress_run   "Build and switch" -- nixos-rebuild switch --flake "path:${CHECKOUT}/nix#box"

progress_end "box now runs ${new}: ${subject}"
```

## Rendering

### Detection

Render mode is chosen once in `progress_begin`:

- **Plain** if any of: stdout is not a TTY (`! [ -t 1 ]`), `NO_COLOR` is set,
  `TERM` is empty or `dumb`, or `PROGRESS_PLAIN=1` (explicit override).
- **Rich** otherwise.

### Rich (TTY)

A live-redrawn block: one line per phase, the active phase animated, and under an
active `progress_run` the child's last line.

```
✓ Fetch main            0.4s
✓ Verify deploy token   0.1s
⠸ Build and switch      2m14s
    │ copying path '/nix/store/…-comfyui-gfx1151' (2.1 GiB)…
```

- Completed phases show `✓` (green) or `✗` (red) with elapsed.
- The active phase shows a Braille spinner frame and a ticking elapsed, advanced
  by a ~10 Hz redraw.
- The tail line is truncated to terminal width and stripped of the child's own
  carriage returns (`nix` and `docker` redraw with `\r`; passing those through
  corrupts the display, the same `tr -d '\r'` the repo already does elsewhere).
- Cursor is hidden during a session and restored on exit, including on `INT`/`TERM`
  via a trap, so a Ctrl-C never leaves the terminal cursorless.

### Plain (non-TTY)

Append-only, one line per transition, no ANSI, no redraws. A `progress_run`
child's native output streams straight through between its start and end markers,
so the journal keeps the full record.

```
[box-deploy] Fetch main: ok (0.4s)
[box-deploy] Verify deploy token: ok (0.1s)
[box-deploy] Build and switch: start
<nixos-rebuild's own output streams here, unmodified>
[box-deploy] Build and switch: ok (3m01s)
box-deploy: box now runs abc1234 (2m59s build)
```

## The live-tail mechanism (`progress_run`)

1. Create a per-run log via `mktemp`.
2. Run the child with stdout+stderr piped to a reader that (a) appends every line
   to the log and (b) keeps the most recent non-empty, `\r`-split segment in a
   variable the renderer reads. In rich mode a background redraw loop paints the
   spinner + tail at ~10 Hz; in plain mode the reader just tees the child's output
   through untouched.
3. On child exit: stop the redraw loop, capture the exit code, render the phase
   `✓`/`✗` with elapsed. On failure, print the last ~20 lines of the log and the
   log path. Always `return` the child's exit code.

Capturing the child's exit code (not the pipeline's) matters: the naive
`cmd | reader` yields the reader's status. Use a `PIPESTATUS`-based read (bash) so
a failing child is not masked by a succeeding tee.

## Logging and failure semantics

- Every `progress_run` tees full child output to a log, so success stays visually
  quiet while any failure has a real post-mortem. The log path is printed on
  failure.
- `progress_run` returns the child's exit status; scripts using `set -euo
  pipefail` abort naturally, after the failure is shown.
- `progress_fail` and an unexpected `progress_end` with an open phase both render
  a clear terminal state rather than leaving a dangling spinner.

## Consumption from box.provisioning

`dev-tools` is public, so `box.provisioning` references the lib by a pinned commit
rather than vendoring a drifting copy:

```nix
progressSrc = pkgs.fetchFromGitHub {
  owner = "Made-I-T"; repo = "dev-tools";
  rev = "<pinned-commit>"; hash = "<sri-hash>";
};
# scripts source "${progressSrc}/src/progress/progress.bash"
```

This keeps the store copy reproducible and updates deliberate (bump the rev),
matching how the repo already pins container images by digest.

## Testing

- `shellcheck` on `progress.bash` (the repo already shellchecks rendered scripts;
  this is the source).
- A `bats` suite covering the behaviors that are easy to regress:
  plain-mode output for a passing and a failing `progress_run` (exact lines),
  exit-code propagation through the tee, phase timing format, and `\r` stripping.
  Rich-mode is asserted by forcing a pseudo-TTY and snapshotting a frame; the
  bulk of the logic (state, timing, exit codes, plain output) is testable without
  a terminal.

## Out of scope (v1)

- Nested phases / sub-steps under a phase. Flat phases plus one live-tail line.
- Determinate percentage bars. The long-poles (`nix`, `docker` first pull) do not
  expose a reliable total; the tail is the honest signal.
- Parsing `nix`/`docker` native progress into structured bars. A later iteration
  could special-case them; v1 shows their raw last line.
- Emitting progress phases as OTLP spans. Tempting given the observability stack,
  but a separate concern from terminal feedback.
