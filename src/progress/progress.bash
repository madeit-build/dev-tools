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

_progress_cursor_show() { [ "${_PROGRESS_MODE:-}" = rich ] && printf '\033[?25h'; }

_progress_spin_frame() {
  # Frames in an ARRAY: bash 3.2 substring indexing is byte-based and would slice
  # these 3-byte Braille glyphs; array element access does not.
  local frames
  frames=( '⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏' )
  _PROGRESS_SPIN=$(( (${_PROGRESS_SPIN:-0} + 1) % 10 ))
  printf '%s' "${frames[$_PROGRESS_SPIN]}"
}

# Repaint the block: completed phase lines plus the active spinner line. Rich only.
_progress_repaint() {
  [ "${_PROGRESS_MODE:-}" = rich ] || return 0
  if [ "${_PROGRESS_PAINTED:-0}" -gt 0 ]; then
    tput cuu "$_PROGRESS_PAINTED" 2>/dev/null
    tput ed 2>/dev/null
  fi
  _PROGRESS_PAINTED=0
  local line
  if [ "${#_PROGRESS_DONE_LINES[@]}" -gt 0 ]; then
    for line in "${_PROGRESS_DONE_LINES[@]}"; do
      printf '%s\n' "$line"
      _PROGRESS_PAINTED=$(( _PROGRESS_PAINTED + 1 ))
    done
  fi
  if [ -n "${_PROGRESS_PHASE_LABEL:-}" ]; then
    local now el
    now="$(_progress_now_ms)"
    el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
    printf '%s %s  %s\n' "$(_progress_spin_frame)" "$_PROGRESS_PHASE_LABEL" "$el"
    _PROGRESS_PAINTED=$(( _PROGRESS_PAINTED + 1 ))
  fi
}

progress_begin() {
  _PROGRESS_TITLE="${1:-}"
  _PROGRESS_MODE="$(_progress_mode)"
  _PROGRESS_START_MS="$(_progress_now_ms)"
  _PROGRESS_PHASE_LABEL=""
  _PROGRESS_PHASE_START_MS=""
  _PROGRESS_DONE_LINES=()
  _PROGRESS_PAINTED=0
  _PROGRESS_SPIN=0
  if [ "$_PROGRESS_MODE" = rich ]; then
    printf '\033[?25l'                       # hide cursor
    trap '_progress_cursor_show' EXIT INT TERM
  fi
}

# Close the open phase, if any. $1=ok|fail  $2=reason(optional)
_progress_close_phase() {
  [ -n "${_PROGRESS_PHASE_LABEL:-}" ] || return 0
  local now el extra=""
  now="$(_progress_now_ms)"
  el="$(_progress_fmt_elapsed $(( now - _PROGRESS_PHASE_START_MS )))"
  [ -n "${2:-}" ] && extra=" - $2"
  if [ "$_PROGRESS_MODE" = rich ]; then
    local sym color reset
    reset="$(tput sgr0 2>/dev/null)"
    if [ "$1" = ok ]; then sym='✓'; color="$(tput setaf 2 2>/dev/null)"
    else sym='✗'; color="$(tput setaf 1 2>/dev/null)"; fi
    _PROGRESS_DONE_LINES+=( "${color}${sym}${reset} ${_PROGRESS_PHASE_LABEL}${extra}  ${el}" )
    _PROGRESS_PHASE_LABEL=""
    _progress_repaint
  else
    printf '[%s] %s: %s%s (%s)\n' "$_PROGRESS_TITLE" "$_PROGRESS_PHASE_LABEL" "$1" "$extra" "$el"
    _PROGRESS_PHASE_LABEL=""
  fi
}

progress_phase() {
  _progress_close_phase ok
  _PROGRESS_PHASE_LABEL="$1"
  _PROGRESS_PHASE_START_MS="$(_progress_now_ms)"
  [ "$_PROGRESS_MODE" = rich ] && _progress_repaint
  return 0
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
  if [ "$_PROGRESS_MODE" = rich ]; then
    local msg="done"; [ -n "${1:-}" ] && msg="$1"
    printf '%s  %s (%s)\n' "$_PROGRESS_TITLE" "$msg" "$el"
    _PROGRESS_PAINTED=0
    _progress_cursor_show
    trap - EXIT INT TERM
  else
    if [ -n "${1:-}" ]; then
      printf '%s: %s (%s)\n' "$_PROGRESS_TITLE" "$1" "$el"
    else
      printf '%s: done (%s)\n' "$_PROGRESS_TITLE" "$el"
    fi
  fi
}
