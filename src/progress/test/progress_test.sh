#!/usr/bin/env bash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fails=0
assert_eq() { # $1=desc $2=expected $3=actual
  if [ "$2" != "$3" ]; then
    printf 'FAIL: %s\n  expected: %q\n  actual:   %q\n' "$1" "$2" "$3"; fails=$((fails+1))
  else
    printf 'ok: %s\n' "$1"
  fi
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
# Timings are nondeterministic; strip the trailing "(...s)" for comparison.
norm="$(printf '%s\n' "$out" | sed -E 's/ \([0-9hms.]+\)$//')"
expected='[demo] first: ok
[demo] second: ok
demo: done'
assert_eq "plain begin/phase/end shape" "$expected" "$norm"

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

[ "$fails" -eq 0 ] || exit 1
echo "ALL PASS"
