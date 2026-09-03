# progress

A sourceable bash progress reporter. Narrate a script's known phases and
live-tail its opaque long-poles (`nixos-rebuild`, `docker pull`), on a TTY it
renders an animated checklist, off a TTY it degrades to plain append-only lines
and never emits ANSI.

One file, no dependencies, bash 3.2 compatible (works on macOS `/bin/bash`).

## Use

```bash
source /path/to/progress.bash

progress_begin "box-deploy"
progress_phase "Fetch main";         git -C "$checkout" fetch --quiet origin main
progress_phase "Verify deploy token"; check_token_expiry
progress_run   "Build and switch" -- nixos-rebuild switch --flake "path:${checkout}/nix#box"
progress_end   "box now runs ${new}"
```

On a terminal:

```
✓ Fetch main            0.4s
✓ Verify deploy token   0.1s
⠸ Build and switch      2m14s
    | copying path '/nix/store/…-comfyui-gfx1151' (2.1 GiB)…
```

Off a terminal (systemd journal, CI, a pipe), the same script:

```
[box-deploy] Fetch main: ok (0.4s)
[box-deploy] Verify deploy token: ok (0.1s)
[box-deploy] Build and switch: start
<the wrapped command's own output streams straight through>
[box-deploy] Build and switch: ok (3m01s)
box-deploy: box now runs abc1234 (2m59s)
```

## API

| Function                             | What it does                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `progress_begin "<title>"`           | Start a session and the clock. Picks rich or plain once.                                                                                     |
| `progress_phase "<label>"`           | Open a phase for inline work. Auto-closes the previous as done.                                                                              |
| `progress_run "<label>" -- <cmd...>` | Run an opaque child: live-tail it, tee full output to a log, return the child's exit code (so `set -e` still applies). The `--` is required. |
| `progress_fail "<reason>"`           | Close the current phase as failed with a reason.                                                                                             |
| `progress_end ["<summary>"]`         | Close any open phase, print a summary and total elapsed.                                                                                     |

`progress_run` tees the child's full output to a `mktemp` log; on failure it
prints the last 20 lines and the log path.

## Environment

| Variable               | Effect                                               |
| ---------------------- | ---------------------------------------------------- |
| `PROGRESS_PLAIN=1`     | Force plain mode even on a TTY.                      |
| `NO_COLOR`             | Any value forces plain mode (honored by convention). |
| `TERM` empty or `dumb` | Plain mode.                                          |

Plain mode is also automatic whenever stdout is not a terminal.

## Notes

- **bash 3.2:** no associative arrays or `mapfile`; the spinner frames are held
  in an indexed array because 3.2 string indexing is byte-based and would slice
  the multibyte glyphs.
- **Cursor safety:** rich mode hides the cursor and restores it on exit via an
  `EXIT`/`INT`/`TERM` trap, so Ctrl-C never leaves the terminal cursorless. If
  your script installs its own `EXIT` trap, call `progress_end` before it runs
  (or restore the cursor yourself with `printf '\033[?25h'`).

## Test

```bash
bash src/progress/test/progress_test.sh
```

The deterministic core (phase state, timing, exit-code propagation, plain output)
is asserted with `PROGRESS_PLAIN=1`, no terminal required. Run against
`/bin/bash` too to keep it 3.2-clean.
