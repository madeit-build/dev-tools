# madeit-log CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `madeit-log` command that lets bash emit `madeit-log-v1` records through the existing TypeScript core, with a per-event mode and a streaming `pipe` mode, packaged for box, vik, cerberus and martinez.

**Architecture:**
- `cli.ts` lives in `src/log/src/core` beside the core it wraps, exposed as a `bin` of `@madeit-build/log`.
- `main(argv, env, io)` is pure and injectable, so vitest drives it in-process. A small entrypoint guard runs it when it is executed directly.
- box.provisioning builds it from the pinned `dev-tools` flake input: `pnpm_10.fetchDeps`, then `bun build` into one file, wrapped with Bun.

**Tech Stack:**
- TypeScript on Node APIs only (`node:fs`, `node:url`, streams), and `@logtape/logtape` through the core;
- vitest and ajv, as the core already uses;
- in box.provisioning: nixpkgs' `pnpm_10.fetchDeps` (`fetcherVersion = 4`), `pnpmConfigHook`, `bun`, `makeWrapper`.

**Spec:** `docs/specs/2026-09-26-madeit-log-cli-design.md`

## Global Constraints

- **Usage:**
  - `madeit-log <debug|info|warn|error> <event> <body> [key=value ...]`
  - `madeit-log pipe <event> [--level debug|info|warn|error] [--stream stdout|stderr] [--tee]`
  - `madeit-log --help`
- **Resource environment variables:** `MADEIT_SERVICE`, `MADEIT_VERSION`, `MADEIT_ENVIRONMENT`, `MADEIT_REPO`, `MADEIT_COMPONENT`. A missing one becomes `"unknown"`, and the comma-separated missing variable names go in attribute `madeit.missing_resource`.
- **Trace:** `TRACEPARENT`, passed to the core's `withTrace`.
- **Sink:** `MADEIT_LOG_SINK=stderr|stdout|file:<path>`, default `stderr`. Any other value falls back to stderr and records the bad value as `madeit.invalid_sink`.
- **Attribute values:** a value that `JSON.parse` turns into a number, boolean or null keeps that type; anything else stays a string. An argument without `=` is collected into `madeit.invalid_attribute` (the offending arguments joined with a space).
- **Exit status:** `main` resolves `0` for any caller input. Misuse is emitted as event `log.meta`, level error, body `madeit-log was called incorrectly`, with `madeit.error` describing the misuse and a usage hint.
- **`pipe`:**
  - one record per line, with attribute `madeit.line` (the line's text) and `madeit.stream` (default `stdout`);
  - default level `info`;
  - `--tee` writes the raw input bytes to stdout unchanged;
  - a final line without a trailing newline still becomes a record;
  - lines are split on `\n`, and a trailing `\r` is removed from the logged text but kept in the tee.
- **Truncation:** a line longer than 16384 UTF-8 bytes is cut to 16384 bytes, with `madeit.truncated: true` and `madeit.line_bytes: <original byte length>`.
- **The core gains `stderrSink()`,** exported beside `stdoutSink()`.
- **Security text:** README and `--help` must say that `pipe` logs line content verbatim and that key-based redaction does not inspect values: never pipe a command whose output can carry credentials.
- dev-tools conventions: pnpm, vitest, `tsc` build to `dist/`, Node >= 22. No em dashes. American English. Why-comments, two sentences maximum. Repo-relative paths only in committed files.
- Plans, specs and ADRs are records. Do not edit them.

## Review Focus

1. **A logging call that kills its caller.** Any exception in `main` must still resolve 0, including a sink that throws, an unreadable stdin, or a thrown JSON serialization. Pinned in Task 2 with a throwing-sink test.
2. **`--tee` altering output.** CRLF, a missing final newline and binary-ish bytes must pass through byte for byte. Pinned in Task 3.
3. **Redaction through the CLI path.** Every `redaction-cases.json` case given as `key=value` must be kept, dropped or truncated as its `expect` says. Pinned in Task 2.
4. **The bin entrypoint when invoked through a symlink** (npm's `node_modules/.bin`). The main-module guard must compare real paths. Pinned in Task 4.
5. **The Nix bundle actually running.** The derivation's check phase executes the wrapped binary and validates one record. Pinned in Task 5.

---

### Task 1: `stderrSink()` in the core (dev-tools)

**Files:**
- Modify: `src/log/src/core/sink.ts`, `src/log/src/core/index.ts` (re-export), `src/log/src/core/sink.test.ts`

- [ ] **Step 1: Failing test** in `sink.test.ts`, mirroring the existing `stdoutSink` test. Spy on `process.stderr.write`, emit one record through `stderrSink()`, and assert that exactly one line of serialized JSON ending in `\n` was written. Run `pnpm --filter @madeit-build/log test -- sink`. Expected: FAIL, because `stderrSink` is not exported.
- [ ] **Step 2: Implement** `export function stderrSink(): Sink { return (record) => { process.stderr.write(serialize(record) + "\n"); }; }` and add it to `index.ts`'s re-export list.
- [ ] **Step 3:** Run `pnpm --filter @madeit-build/log test` and `pnpm --filter @madeit-build/log run typecheck`. Both pass.
- [ ] **Step 4: Commit:** `feat(log): a stderr sink, for callers whose stdout is data`.

---

### Task 2: `cli.ts` event mode (dev-tools)

**Files:**
- Create: `src/log/src/core/cli.ts`, `src/log/src/core/cli.test.ts`

**Interfaces:**
- Produces:
  - `export async function main(argv: string[], env: Record<string, string | undefined>, io: CliIo): Promise<number>`;
  - `export interface CliIo { stdin: NodeJS.ReadableStream; stdout: { write(chunk: string | Uint8Array): unknown } }`.
- Consumes `getLogger`, `stderrSink`, `stdoutSink`, `fileSink` and `withTrace` from `./index.ts`.

- [ ] **Step 1: Failing tests** in `cli.test.ts`. Each runs `main` with `MADEIT_LOG_SINK=file:<tmp>` and reads the file's JSON lines:
  - `info probe.hello hello madeit.n=1` gives one record: valid against `../../schema/madeit-log-v1.json` (ajv 2020, as `index.test.ts` does), with `SeverityText` INFO, `Body` "hello", `Attributes["madeit.n"] === 1`, and `main` resolving 0;
  - each level word maps to its `SeverityText`, and `warn` gives WARN;
  - value typing: `a=true` gives `true`, `b=null` gives `null`, `c=01` gives the string `"01"`, `d=x=y` gives the string `"x=y"` (the value is everything after the first `=`);
  - `bare` without `=` is recorded as `madeit.invalid_attribute`;
  - **every case in `../../schema/redaction-cases.json`**, given as `key=value`, is kept, dropped (the key is absent) or truncated (the value's length is 12) as its `expect` says;
  - with every `MADEIT_*` resource variable unset, the Resource fields read `unknown`, and `madeit.missing_resource` names all five variables;
  - `TRACEPARENT=00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01` sets `TraceId` and `SpanId`;
  - misuse resolves 0 and emits exactly one `log.meta` record: no arguments, `shout x y`, and `info` with no event;
  - `MADEIT_LOG_SINK=bogus` still emits, and carries `madeit.invalid_sink: "bogus"`. For this case, capture stderr by spying on `process.stderr.write`;
  - **Review Focus 1:** `main` resolves 0 when the chosen file sink's directory does not exist.

  Run `pnpm --filter @madeit-build/log test -- cli`. Expected: FAIL, because `./cli.ts` does not exist.
- [ ] **Step 2: Implement** `cli.ts` event mode:
  - parse the level, event, body and attributes;
  - build the resource from the environment, marking anything missing;
  - choose the sink;
  - `getLogger(...)`, then `withTrace(env.TRACEPARENT)`, then the level method;
  - wrap the whole body in `try`/`catch` so it always resolves 0. On an unexpected error, write one line `madeit-log: <message>` to stderr and resolve 0.

  `--help` writes the usage (including the security sentence from Global Constraints) to `io.stdout` and resolves 0.
- [ ] **Step 3:** Run the tests and the typecheck. All pass.
- [ ] **Step 4: Commit:** `feat(log): madeit-log, one record per call from bash`.

---

### Task 3: `pipe` mode (dev-tools)

**Files:**
- Modify: `src/log/src/core/cli.ts`, `src/log/src/core/cli.test.ts`

- [ ] **Step 1: Failing tests.** Each feeds `io.stdin` from a `Readable.from([...Buffer chunks])` and captures `io.stdout` into a Buffer:
  - `pipe build.output` over `"a\nb\n"` gives two records, `madeit.line` "a" and "b", `madeit.stream` "stdout", INFO, each valid against the schema;
  - `--stream stderr --level warn` is reflected in every record;
  - input without a final newline (`"a\nb"`) gives two records;
  - **Review Focus 2:** `--tee` output equals the input bytes exactly, for:
    - `"a\r\nb"`;
    - an input split across chunk boundaries mid-line and mid-UTF-8 character (for example `"é"`'s two bytes in different chunks);
    - `Buffer.from([0x00, 0xff, 0x0a])`.
  - `\r\n` input logs `madeit.line` without the `\r`;
  - a 20000-byte line is cut to 16384 bytes with `madeit.truncated: true` and `madeit.line_bytes: 20000`;
  - 10,000 lines give 10,000 records from one `main` call;
  - `pipe` with no event, or with an unknown flag, gives `log.meta` and resolves 0 without reading stdin.

  Run the tests. Expected: FAIL, because `pipe` is not implemented.
- [ ] **Step 2: Implement `pipe`:**
  - read `io.stdin` as Buffer chunks;
  - with `--tee`, write each chunk to `io.stdout` as it arrives;
  - split lines on the `0x0a` byte, carrying the partial remainder across chunks;
  - decode each complete line as UTF-8 only once it is complete;
  - emit any remainder at end of input.
- [ ] **Step 3:** Run the tests and the typecheck. All pass.
- [ ] **Step 4: Commit:** `feat(log): madeit-log pipe, a subprocess's output as records`.

---

### Task 4: The bin, the entrypoint and the README (dev-tools)

**Files:**
- Modify: `src/log/src/core/cli.ts` (shebang and entrypoint guard), `src/log/src/core/package.json` (`"bin"`), `src/log/src/core/cli.test.ts`, `src/log/README.md`

- [ ] **Step 1: Failing test.** Build with `pnpm --filter @madeit-build/log run build`. Create a symlink in a temp dir pointing at `dist/cli.js`, the way npm's `.bin` would. Run it as a subprocess with `process.execPath <symlink> info probe.bin hi`, with `MADEIT_LOG_SINK` unset. Assert that stderr carries one valid record and the exit code is 0. Also run `process.execPath <symlink> shout`: exit 0, and stderr carries a `log.meta` record. Expected: FAIL, because nothing runs when the file is executed.
- [ ] **Step 2: Implement:**
  - `#!/usr/bin/env node` as the first line of `cli.ts`;
  - at the bottom, a guard that runs `main` only when `fs.realpathSync(process.argv[1])` equals `fileURLToPath(import.meta.url)`, setting `process.exitCode` from its result;
  - `"bin": { "madeit-log": "./dist/cli.js" }` in `package.json`.

  Confirm `tsc` keeps the shebang in `dist/cli.js`. If the build config rejects top-level await, make the guard call `main(...).then(...)` instead.
- [ ] **Step 3: README:** a "## Bash" section covering:
  - both modes, with the `2> >(... --stream stderr --tee >&2) | ... --tee` capture example;
  - the environment variables;
  - the stderr default and its reason;
  - the never-nonzero rule;
  - the measured costs table from the spec;
  - **the security warning** about `pipe` and values.
- [ ] **Step 4:** Run the full `pnpm --filter @madeit-build/log test`, `typecheck` and `build`. All pass.
- [ ] **Step 5: Commit:** `feat(log): madeit-log ships as a bin, documented for bash`.

Then push and open the dev-tools PR. Merging publishes a new `@madeit-build/log` patch version through `publish-log.yml`.

---

### Task 5: Package it for the fleet (box.provisioning, after the dev-tools merge)

Work on a fresh branch off `origin/main` in a `box.provisioning-worktrees` worktree. First run `nix flake update dev-tools --flake ./nix`, so the input carries the CLI.

**Files:**
- Create: `nix/pkgs/madeit-log-cli.nix`
- Modify:
  - `nix/hosts/module-lists/shared.nix`, or a small module it imports, adding `environment.systemPackages` on box and vik;
  - `nix/hosts/cerberus/default.nix` (cerberus does not import `shared.nix`);
  - `nix/home/toolchain.nix` (martinez);
  - `nix/flake.lock`.

- [ ] **Step 1: The derivation.** This is the recipe proven on 2026-09-26, bundling the current `index.ts` on x86_64-linux through vik. `callPackage` it with `devToolsSrc`:
  ```nix
  { lib, stdenvNoCC, nodejs, pnpm_10, pnpmConfigHook, bun, makeWrapper, devToolsSrc }:
  let
    pname = "madeit-log-cli";
    version = (lib.importJSON "${devToolsSrc}/src/log/src/core/package.json").version;
  in stdenvNoCC.mkDerivation {
    inherit pname version;
    src = devToolsSrc;
    pnpmWorkspaces = [ "@madeit-build/log" ];
    # Pinned by content against dev-tools' own pnpm-lock.yaml; the weekly
    # flake bump moves devToolsSrc, and a changed lock fails here until updated.
    pnpmDeps = pnpm_10.fetchDeps {
      inherit pname version;
      src = devToolsSrc;
      pnpmWorkspaces = [ "@madeit-build/log" ];
      fetcherVersion = 4;
      hash = lib.fakeHash;
    };
    nativeBuildInputs = [ nodejs pnpm_10 pnpmConfigHook bun makeWrapper ];
    buildPhase = ''
      runHook preBuild
      bun build src/log/src/core/cli.ts --target=node --outfile madeit-log.js
      runHook postBuild
    '';
    installPhase = ''
      mkdir -p $out/lib $out/bin
      cp madeit-log.js $out/lib/
      makeWrapper ${bun}/bin/bun $out/bin/madeit-log --add-flags $out/lib/madeit-log.js
    '';
    doInstallCheck = true;
    installCheckPhase = ''
      MADEIT_SERVICE=check MADEIT_VERSION=${version} MADEIT_ENVIRONMENT=build \
        MADEIT_REPO=dev-tools MADEIT_COMPONENT=cli \
        $out/bin/madeit-log info probe.check "install check" madeit.n=1 2>record.json
      ${lib.getExe' nodejs "node"} -e '
        const r = JSON.parse(require("fs").readFileSync("record.json", "utf8"));
        if (r.Body !== "install check" || r.Attributes["madeit.n"] !== 1) process.exit(1);'
    '';
  }
  ```
- [ ] **Step 2: The hash.** Build it through vik with `lib.fakeHash` and replace the hash with the reported `got:` value. The prototype's hash (`sha256-an7pCBWISyS7GLzIqZvO/viVhpmlhqVuIR8kdI462LY=`) is for the pre-CLI lock and will differ if the lock changed.
- [ ] **Step 3: Install check, both ways.** Build for x86_64-linux and confirm the install check passes. Then break the check deliberately (expect `Body` "wrong") and confirm the build fails. Revert.
- [ ] **Step 4: Wire it in:**
  - box and vik: `environment.systemPackages` through the shared module list;
  - cerberus: directly;
  - martinez: in `toolchain.nix`.

  Evaluate `nix eval` of each host's `environment.systemPackages` names, or `home.packages` for martinez, to confirm `madeit-log-cli` is present. CI's `cerberus-build` covers aarch64.
- [ ] **Step 5:** Run `scripts/gen-option-types.bash` only if a new `madeit.*` option was added; none is expected. Commit: `feat(nix): madeit-log for bash on every host`. Push, open the PR, and CI must pass.
- [ ] **Step 6 (operator):** After merge and deploys, `madeit-log info probe.hello hello` on box, vik, cerberus and martinez prints a record to stderr (spec success criterion 1).
