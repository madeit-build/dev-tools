# shell-progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (or subagent-driven-development). Steps use checkbox (`- [ ]`) syntax. This is a bash library; "tests" are assertions in a dependency-free shell harness run with `bash test/progress_test.sh`.

**Goal:** A sourceable `progress.bash` that renders a phase checklist + live-tailed opaque commands on a TTY and clean append-only lines off it, adopted first by `box-deploy`.

**Architecture:** One self-contained bash file exposing `progress_begin/phase/run/fail/end`. Render mode (rich vs plain) is chosen once from `[ -t 1 ]` and env. `progress_run` owns opaque children: tee to a log, propagate exit code via `PIPESTATUS`, live-tail in rich mode. A dependency-free `test/progress_test.sh` asserts the plain-mode contract (the deterministic, TTY-free logic).

**Tech Stack:** POSIX-ish bash targeting **3.2** (macOS `/bin/bash`), no external deps.

## Global Constraints

- **bash 3.2 compatible.** No associative arrays, no `mapfile`/`readarray`, no `${var^^}`. Indexed arrays and plain vars only.
- **Never emit ANSI to a non-TTY.** Plain mode is the default whenever `! [ -t 1 ]`, `NO_COLOR` set, `TERM` empty/`dumb`, or `PROGRESS_PLAIN=1`.
- **Exit codes propagate.** `progress_run` returns the child's status (via `PIPESTATUS`), never the tee's.
- **No em dashes** in any file (repo/author convention). Repo-relative paths only.
- **Self-contained:** one `progress.bash`, sourceable, no build step, invisible to pnpm/turbo (no `src/*/package.json`).

---

### Task 1: Plain-mode session + phases (begin / phase / end)

**Files:**

- Create: `src/progress/progress.bash`
- Create: `src/progress/test/progress_test.sh`

**Interfaces:**

- Produces: `progress_begin`, `progress_phase`, `progress_end`, and internal `_progress_now_ms`, `_progress_fmt_elapsed`, `_progress_mode`. Consumed by all later tasks.

- [ ] **Step 1: Write the failing test**

`src/progress/test/progress_test.sh`:

```bash
#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0
assert_eq() { # $1=desc $2=expected $3=actual
  if [ "$2" != "$3" ]; then printf 'FAIL: %s\n  expected: %q\n  actual:   %q\n' "$1" "$2" "$3"; fails=$((fails+1));
  else printf 'ok: %s\n' "$1"; fi
}

# Force plain mode regardless of the harness's TTY.
export PROGRESS_PLAIN=1
# shellcheck source=../progress.bash
source "$HERE/../progress.bash"

# begin/phase/phase/end emits one line per transition, phases auto-close.
out="$(
  progress_begin "demo"
  progress_phase "first"
  progress_phase "second"
  progress_end "done"
)"
# Timings are nondeterministic; strip the "(...s)" suffix for comparison.
norm="$(printf '%s\n' "$out" | sed -E 's/ \([0-9hms.]+\)$//')"
expected='[demo] first: ok
[demo] second: ok
demo: done'
assert_eq "plain begin/phase/end shape" "$expected" "$norm"

[ "$fails" -eq 0 ] || exit 1
echo "ALL PASS"
```

- [ ] **Step 2: Run it, watch it fail**

Run: `bash src/progress/test/progress_test.sh`
Expected: FAIL (source error: `progress.bash` does not exist yet).

- [ ] **Step 3: Implement the plain-mode core**

`src/progress/progress.bash`:

```bash
# shell-progress: a sourceable phase + progress reporter. See docs/specs.
# bash 3.2 compatible. Source this, then call progress_begin ... progress_end.

_progress_now_ms() {
  # date +%s%3N is not portable to macOS date; use bash SECONDS-free ms via perl
  # only if present, else whole seconds. Whole-second resolution is fine for the
  # phase timings we display.
  printf '%s000' "$(date +%s)"
}

_progress_fmt_elapsed() { # $1=ms
  local s=$(( ${1:-0} / 1000 ))
  if   [ "$s" -ge 3600 ]; then printf '%dh%02dm' $(( s/3600 )) $(( (s%3600)/60 ))
  elif [ "$s" -ge 60 ];   then printf '%dm%02ds' $(( s/60 )) $(( s%60 ))
  else printf '%ds' "$s"; fi
}

_progress_mode() {
  if [ "${PROGRESS_PLAIN:-0}" = "1" ] || [ -z "${TERM:-}" ] || [ "${TERM:-}" = "dumb" ] \
     || [ -n "${NO_COLOR:-}" ] || ! [ -t 1 ]; then printf 'plain'; else printf 'rich'; fi
}

progress_begin() {
  _PROGRESS_TITLE="${1:-}"
  _PROGRESS_MODE="$(_progress_mode)"
  _PROGRESS_START_MS="$(_progress_now_ms)"
  _PROGRESS_PHASE_LABEL=""
  _PROGRESS_PHASE_START_MS=""
}

# Close the open phase, if any, as ok (plain mode for now).
_progress_close_phase() { # $1=status(ok|fail) $2=reason(optional)
  [ -n "${_PROGRESS_PHASE_LABEL:-}" ] || return 0
  local now el
  now="$(_progress_now_ms)"; el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
  local extra=""; [ -n "${2:-}" ] && extra=" - $2"
  printf '[%s] %s: %s%s (%s)\n' "$_PROGRESS_TITLE" "$_PROGRESS_PHASE_LABEL" "$1" "$extra" "$el"
  _PROGRESS_PHASE_LABEL=""
}

progress_phase() {
  _progress_close_phase ok
  _PROGRESS_PHASE_LABEL="$1"
  _PROGRESS_PHASE_START_MS="$(_progress_now_ms)"
}

progress_fail() { _progress_close_phase fail "${1:-}"; }

progress_end() {
  _progress_close_phase ok
  local now el; now="$(_progress_now_ms)"; el="$(_progress_fmt_elapsed $(( now - _PROGRESS_START_MS )))"
  if [ -n "${1:-}" ]; then printf '%s: %s (%s)\n' "$_PROGRESS_TITLE" "$1" "$el"
  else printf '%s: done (%s)\n' "$_PROGRESS_TITLE" "$el"; fi
}
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `bash src/progress/test/progress_test.sh`
Expected: `ok: plain begin/phase/end shape` then `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/progress/progress.bash src/progress/test/progress_test.sh
git commit -m "feat(progress): plain-mode session and phases"
```

---

### Task 2: progress_run (plain) - child exec, exit-code propagation, log, failure output

**Files:**

- Modify: `src/progress/progress.bash`
- Modify: `src/progress/test/progress_test.sh`

**Interfaces:**

- Consumes: Task 1 internals.
- Produces: `progress_run "<label>" -- <cmd...>`, returns the child's exit code.

- [ ] **Step 1: Add failing tests**

Append to `progress_test.sh` before the final `[ "$fails" ... ]`:

```bash
# progress_run passes on success, returns 0, streams child output through.
run_out="$(
  progress_begin "d"
  progress_run "step" -- sh -c 'echo hello; echo world'
  progress_end
)"; run_rc=$?
assert_eq "run success rc" "0" "$run_rc"
case "$run_out" in
  *"[d] step: start"*"hello"*"world"*"[d] step: ok"*) echo "ok: run streams + markers";;
  *) echo "FAIL: run streams + markers"; printf '%s\n' "$run_out"; fails=$((fails+1));;
esac

# progress_run propagates a non-zero child exit code.
( progress_begin "d"; progress_run "boom" -- sh -c 'exit 7'; ) >/dev/null 2>&1
assert_eq "run failure rc propagates" "7" "$?"
```

- [ ] **Step 2: Run, watch the new asserts fail**

Run: `bash src/progress/test/progress_test.sh`
Expected: the two new lines FAIL (`progress_run` undefined).

- [ ] **Step 3: Implement progress_run**

Add to `progress.bash`. The `--` is required; everything after it is the command. Use a FIFO-free approach: run the child with output teed to a log and passed through, capturing the child's status from `PIPESTATUS[0]`.

```bash
progress_run() {
  local label="$1"; shift
  [ "$1" = "--" ] || { printf 'progress_run: expected -- before command\n' >&2; return 2; }
  shift
  _progress_close_phase ok
  _PROGRESS_PHASE_LABEL="$label"
  _PROGRESS_PHASE_START_MS="$(_progress_now_ms)"

  local log; log="$(mktemp "${TMPDIR:-/tmp}/progress.XXXXXX")"
  printf '[%s] %s: start\n' "$_PROGRESS_TITLE" "$label"

  # Plain mode (rich overrides this in Task 5): tee child output through to the
  # terminal and into the log; PIPESTATUS[0] is the child's real exit code.
  "$@" 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}

  _PROGRESS_PHASE_LABEL=""   # closed explicitly below with the child's verdict
  local now el; now="$(_progress_now_ms)"; el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
  if [ "$rc" -eq 0 ]; then
    printf '[%s] %s: ok (%s)\n' "$_PROGRESS_TITLE" "$label" "$el"
    rm -f "$log"
  else
    printf '[%s] %s: FAILED rc=%s (%s)\n' "$_PROGRESS_TITLE" "$label" "$rc" "$el"
    printf '  last output (%s):\n' "$log"
    tail -n 20 "$log" | sed 's/^/  | /'
  fi
  return "$rc"
}
```

- [ ] **Step 4: Run tests, watch pass**

Run: `bash src/progress/test/progress_test.sh`
Expected: `ok: run streams + markers`, `ok: run success rc`, `ok: run failure rc propagates`, `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add -A src/progress
git commit -m "feat(progress): progress_run with exit-code propagation and failure log"
```

---

### Task 3: Rich TTY rendering - checklist, spinner, cursor-safe

**Files:**

- Modify: `src/progress/progress.bash`

**Interfaces:**

- Consumes: mode from Task 1.
- Produces: rich rendering for `progress_phase`/`progress_end`. No API change.

- [ ] **Step 1: Implement rich rendering behind the mode switch**

In rich mode, keep an indexed array of completed phase lines and repaint the block on each transition. Hide the cursor on `progress_begin`, restore it on `progress_end` and via a trap so Ctrl-C never leaves it hidden.

```bash
# state (rich): _PROGRESS_DONE_LINES[] holds finished "✓ label  time" strings.
_progress_paint() { # repaint completed lines + the active spinner line
  [ "$_PROGRESS_MODE" = rich ] || return 0
  local i; tput cuu "${_PROGRESS_PAINTED:-0}" 2>/dev/null; tput ed 2>/dev/null
  _PROGRESS_PAINTED=0
  for i in "${_PROGRESS_DONE_LINES[@]:-}"; do [ -n "$i" ] && { printf '%s\n' "$i"; _PROGRESS_PAINTED=$((_PROGRESS_PAINTED+1)); }; done
  if [ -n "${_PROGRESS_PHASE_LABEL:-}" ]; then
    local now el; now="$(_progress_now_ms)"; el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
    printf '%s %s  %s\n' "$(_progress_spin_frame)" "$_PROGRESS_PHASE_LABEL" "$el"
    _PROGRESS_PAINTED=$((_PROGRESS_PAINTED+1))
  fi
}
_progress_spin_frame() { local f='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'; _PROGRESS_SPIN=$(( (${_PROGRESS_SPIN:-0}+1) % 10 )); printf '%s' "${f:$_PROGRESS_SPIN:1}"; }
```

Guard every escape in `_progress_paint`/cursor calls behind `[ "$_PROGRESS_MODE" = rich ]`. Add to `progress_begin` (rich only): `printf '\033[?25l'` and `trap '_progress_cursor_show' EXIT INT TERM`, where `_progress_cursor_show` prints `\033[?25h` once.

- [ ] **Step 2: Test - plain mode is unchanged, rich does not corrupt piped output**

Run: `bash src/progress/test/progress_test.sh` (still plain, must still PASS).
Then a smoke check that piping forces plain (no escapes):

Run: `bash -c 'source src/progress/progress.bash; progress_begin x; progress_phase a; progress_end' | cat -v | grep -c "\^\["`
Expected: `0` (no ANSI when piped).

- [ ] **Step 3: Commit**

```bash
git add src/progress/progress.bash
git commit -m "feat(progress): rich TTY checklist + spinner, cursor-safe"
```

---

### Task 4: Live-tail for progress_run (rich mode)

**Files:**

- Modify: `src/progress/progress.bash`

**Interfaces:**

- Consumes: Tasks 2 and 3.
- Produces: rich `progress_run` showing the child's last line under the spinner.

- [ ] **Step 1: Implement the tail in rich mode**

In `progress_run`, branch on `_PROGRESS_MODE`. Plain mode keeps the Task 2 tee-through. Rich mode runs the child with output to the log only, and a background loop repaints the spinner line plus the log's last non-empty, `\r`-split segment, truncated to `$(tput cols)`:

```bash
# rich branch inside progress_run, after 'start' is set up:
"$@" >"$log" 2>&1 &
local child=$!
while kill -0 "$child" 2>/dev/null; do
  local last; last="$(tr '\r' '\n' < "$log" | grep -v '^[[:space:]]*$' | tail -n 1)"
  _progress_paint
  [ -n "$last" ] && printf '    | %s\n' "$(printf '%s' "$last" | cut -c1-"$(( $(tput cols 2>/dev/null || echo 80) - 6 ))")"
  sleep 0.1
done
wait "$child"; local rc=$?
```

Then close the phase with `✓`/`✗` into `_PROGRESS_DONE_LINES` and `return "$rc"` (the failure branch still tails 20 lines of the log). Keep the plain branch exactly as Task 2.

- [ ] **Step 2: Test - failure still propagates in a forced-rich run**

Run:

```bash
script -q /dev/null bash -c 'source src/progress/progress.bash; progress_begin d; progress_run boom -- sh -c "exit 5"'; echo "rc=$?"
```

Expected: output ends with `rc=5` (exit code survives the rich tail path; `script` fakes a TTY).

- [ ] **Step 3: Commit**

```bash
git add src/progress/progress.bash
git commit -m "feat(progress): live-tail opaque commands in rich mode"
```

---

### Task 5: README + shellcheck

**Files:**

- Create: `src/progress/README.md`

- [ ] **Step 1: Write the README**

Cover: what it is, the five functions with one-line signatures, a copy-paste example (the box-deploy snippet), the env switches (`PROGRESS_PLAIN`, `NO_COLOR`), and the bash 3.2 note. Add `progress` to the tools table in the repo root `README.md`.

- [ ] **Step 2: shellcheck clean**

Run: `shellcheck -s bash src/progress/progress.bash`
Expected: no warnings (add narrow `# shellcheck disable=` with a reason only where a construct is deliberate).

- [ ] **Step 3: Commit**

```bash
git add src/progress/README.md README.md
git commit -m "docs(progress): README and root tools-table entry"
```

---

## Follow-up (separate repo, not this plan)

Adopt in `box.provisioning`: pin `dev-tools` via `fetchFromGitHub` at this branch's merge commit, source `progress.bash` in `box-deploy.bash`, and replace the bare `nixos-rebuild switch` with `progress_run "Build and switch" -- nixos-rebuild switch ...`. Its own spec/plan/PR there.

## Self-Review

- **Spec coverage:** API (Task 1-2), rich/plain rendering + detection (Task 1,3), live-tail + `\r` strip + width truncate (Task 4), exit-code via `PIPESTATUS` (Task 2), failure log (Task 2), README/shellcheck (Task 5). box-deploy adoption is explicitly a separate-repo follow-up.
- **Deviation from spec:** dependency-free shell harness instead of `bats`, to match the repo's zero-dep bash convention. Noted.
- **Consistency:** function names (`begin/phase/run/fail/end`), the `--` boundary, plain-line format `[title] label: status (time)`, and the bash 3.2 constraint match the spec throughout.
