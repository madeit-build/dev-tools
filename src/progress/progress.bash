# shell-progress: a sourceable phase + progress reporter for bash scripts.
# See docs/specs/2026-07-20-shell-progress-design.md.
#
# bash 3.2 compatible (macOS /bin/bash). Source this, then:
#   progress_begin "title"
#   progress_phase "label"          # inline work
#   progress_run   "label" -- cmd   # opaque child, live-tailed on a TTY
#   progress_end   "summary"
#
# On a TTY it renders an animated checklist; off a TTY (systemd, CI, a pipe) it
# degrades to plain append-only lines and never emits ANSI.

_progress_now_ms() {
  # Whole-second resolution rendered as ms. macOS `date` has no %N, and second
  # resolution is plenty for the phase timings we show.
  printf '%s000' "$(date +%s)"
}

_progress_fmt_elapsed() { # $1=ms
  local s=$(( ${1:-0} / 1000 ))
  if   [ "$s" -ge 3600 ]; then printf '%dh%02dm' $(( s / 3600 )) $(( (s % 3600) / 60 ))
  elif [ "$s" -ge 60 ];   then printf '%dm%02ds' $(( s / 60 )) $(( s % 60 ))
  else printf '%ds' "$s"
  fi
}

_progress_mode() {
  if [ "${PROGRESS_PLAIN:-0}" = "1" ] || [ -z "${TERM:-}" ] || [ "${TERM:-}" = "dumb" ] \
     || [ -n "${NO_COLOR:-}" ] || ! [ -t 1 ]; then
    printf 'plain'
  else
    printf 'rich'
  fi
}

progress_begin() {
  _PROGRESS_TITLE="${1:-}"
  _PROGRESS_MODE="$(_progress_mode)"
  _PROGRESS_START_MS="$(_progress_now_ms)"
  _PROGRESS_PHASE_LABEL=""
  _PROGRESS_PHASE_START_MS=""
}

# Close the open phase, if any. $1=ok|fail  $2=reason(optional)
_progress_close_phase() {
  [ -n "${_PROGRESS_PHASE_LABEL:-}" ] || return 0
  local now el extra=""
  now="$(_progress_now_ms)"
  el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
  [ -n "${2:-}" ] && extra=" - $2"
  printf '[%s] %s: %s%s (%s)\n' "$_PROGRESS_TITLE" "$_PROGRESS_PHASE_LABEL" "$1" "$extra" "$el"
  _PROGRESS_PHASE_LABEL=""
}

progress_phase() {
  _progress_close_phase ok
  _PROGRESS_PHASE_LABEL="$1"
  _PROGRESS_PHASE_START_MS="$(_progress_now_ms)"
}

progress_fail() { _progress_close_phase fail "${1:-}"; }

# progress_run "label" -- cmd [args...]
# Runs an opaque child, tees its output to a log, and returns the child's exit
# code (via PIPESTATUS, never the tee's). Plain mode streams output through; the
# rich live-tail is layered on in a later change.
progress_run() {
  local label="$1"; shift
  if [ "${1:-}" != "--" ]; then
    printf 'progress_run: expected -- before the command\n' >&2
    return 2
  fi
  shift
  _progress_close_phase ok
  _PROGRESS_PHASE_LABEL="$label"
  _PROGRESS_PHASE_START_MS="$(_progress_now_ms)"

  local log
  log="$(mktemp "${TMPDIR:-/tmp}/progress.XXXXXX")"
  printf '[%s] %s: start\n' "$_PROGRESS_TITLE" "$label"

  "$@" 2>&1 | tee "$log"
  local rc=${PIPESTATUS[0]}

  _PROGRESS_PHASE_LABEL=""
  local now el
  now="$(_progress_now_ms)"
  el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
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

progress_end() {
  _progress_close_phase ok
  local now el
  now="$(_progress_now_ms)"
  el="$(_progress_fmt_elapsed $(( now - _PROGRESS_START_MS )))"
  if [ -n "${1:-}" ]; then
    printf '%s: %s (%s)\n' "$_PROGRESS_TITLE" "$1" "$el"
  else
    printf '%s: done (%s)\n' "$_PROGRESS_TITLE" "$el"
  fi
}
