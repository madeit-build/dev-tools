# Monorepo Runnable Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pnpm + Turborepo monorepo skeleton with a working end-to-end handshake: the VS Code extension spawns the engine server as a child process and exchanges a typed ping/pong over stdio JSON-RPC.

**Architecture:** Standalone engine process + thin IDE clients (see `docs/superpowers/specs/2026-06-12-monorepo-structure-design.md`). Four workspace packages: `@hdtw/protocol` (the contract), `@hdtw/engine-core` (pure domain lib), `@hdtw/engine-server` (stdio JSON-RPC process wrapping core), and the VS Code extension (thin client, depends only on protocol + spawns the server binary). All packages are CommonJS TypeScript compiled with `tsc`.

**Tech Stack:** TypeScript 5.x, pnpm workspaces, Turborepo 2.x, vscode-jsonrpc 8.x, Vitest 3.x, ESLint 9 (flat config) + typescript-eslint, Prettier.

**Conventions used throughout:**
- All commands run from the repository root.
- The spec names the extension package `@hdtw/vscode`, but VS Code extension manifests cannot use npm scopes (the extension ID is `publisher.name`). The package is therefore named `hdtw-vscode` with publisher `madeit` (Made I.T.), giving the full extension ID `madeit.hdtw-vscode`. This is the only intentional deviation from the spec.
- Unit tests are co-located with source (`src/foo.test.ts`) and excluded from `tsc` builds.

---

### Task 1: Root workspace and tooling configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `eslint.config.mjs`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.gitignore`

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "hdtw-monorepo",
  "private": true,
  "packageManager": "pnpm@10.11.0",
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "lint": "turbo run lint",
    "format": "prettier --write ."
  },
  "devDependencies": {
    "eslint": "^9.27.0",
    "prettier": "^3.5.3",
    "turbo": "^2.5.0",
    "typescript": "^5.8.3",
    "typescript-eslint": "^8.32.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "src/protocol"
  - "src/engine/*"
  - "src/clients/*"
```

(`tools/` gets added here when the first tool package exists — YAGNI until then.)

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["build"]
    },
    "lint": {}
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 5: Create `eslint.config.mjs`**

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.turbo/**"],
  },
  ...tseslint.configs.recommended
);
```

- [ ] **Step 6: Create `.prettierrc.json`, `.prettierignore`, and `.gitignore`**

`.prettierrc.json`:

```json
{}
```

`.prettierignore`:

```
dist/
node_modules/
.turbo/
pnpm-lock.yaml
```

`.gitignore`:

```
node_modules/
dist/
.turbo/
*.vsix
.DS_Store
```

- [ ] **Step 7: Verify install works**

Run: `pnpm install`
Expected: succeeds, creates `pnpm-lock.yaml` and `node_modules/`. (If `pnpm` is missing, run `corepack enable pnpm` first.)

Run: `pnpm build`
Expected: turbo reports `No tasks were executed as part of this run` (no packages yet) — exit code 0.

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs .prettierrc.json .prettierignore .gitignore pnpm-lock.yaml
git commit -m "chore: add pnpm + turborepo workspace tooling"
```

---

### Task 2: `@hdtw/protocol` package

**Files:**
- Create: `src/protocol/package.json`
- Create: `src/protocol/tsconfig.json`
- Create: `src/protocol/src/index.ts`
- Test: `src/protocol/src/index.test.ts`

- [ ] **Step 1: Create `src/protocol/package.json`**

```json
{
  "name": "@hdtw/protocol",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `src/protocol/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test — `src/protocol/src/index.test.ts`**

```ts
import { expect, test } from "vitest";
import { PING_METHOD, PROTOCOL_VERSION } from "./index";

test("protocol constants are stable", () => {
  expect(PING_METHOD).toBe("hdtw/ping");
  expect(PROTOCOL_VERSION).toBe("0.0.1");
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @hdtw/protocol test`
Expected: FAIL — `Cannot find module './index'` (or equivalent resolution error).

- [ ] **Step 5: Write the implementation — `src/protocol/src/index.ts`**

```ts
export const PROTOCOL_VERSION = "0.0.1";

/** JSON-RPC method name for the client→engine handshake. */
export const PING_METHOD = "hdtw/ping";

export interface PingParams {
  clientName: string;
  protocolVersion: string;
}

export interface PingResult {
  engineName: string;
  engineVersion: string;
  protocolVersion: string;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @hdtw/protocol test`
Expected: PASS (1 test).

- [ ] **Step 7: Verify the package builds**

Run: `pnpm --filter @hdtw/protocol build`
Expected: exit 0; `src/protocol/dist/index.js` and `index.d.ts` exist, no `index.test.*` in `dist/`.

- [ ] **Step 8: Commit**

```bash
git add src/protocol pnpm-lock.yaml
git commit -m "feat(protocol): add ping/pong handshake contract"
```

---

### Task 3: `@hdtw/engine-core` package

**Files:**
- Create: `src/engine/core/package.json`
- Create: `src/engine/core/tsconfig.json`
- Create: `src/engine/core/src/index.ts`
- Test: `src/engine/core/src/index.test.ts`

- [ ] **Step 1: Create `src/engine/core/package.json`**

```json
{
  "name": "@hdtw/engine-core",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `src/engine/core/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Write the failing test — `src/engine/core/src/index.test.ts`**

```ts
import { expect, test } from "vitest";
import { getEngineInfo } from "./index";

test("getEngineInfo returns engine name and version", () => {
  expect(getEngineInfo()).toEqual({ name: "hdtw-engine", version: "0.0.1" });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm install && pnpm --filter @hdtw/engine-core test`
Expected: FAIL — module resolution error for `./index`.

- [ ] **Step 5: Write the implementation — `src/engine/core/src/index.ts`**

```ts
export interface EngineInfo {
  name: string;
  version: string;
}

export function getEngineInfo(): EngineInfo {
  return { name: "hdtw-engine", version: "0.0.1" };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @hdtw/engine-core test`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add src/engine/core pnpm-lock.yaml
git commit -m "feat(engine-core): add engine info domain stub"
```

---

### Task 4: `@hdtw/engine-server` package

**Files:**
- Create: `src/engine/server/package.json`
- Create: `src/engine/server/tsconfig.json`
- Create: `src/engine/server/src/pingHandler.ts`
- Create: `src/engine/server/src/main.ts`
- Test: `src/engine/server/src/pingHandler.test.ts`
- Test: `src/engine/server/tests/server.e2e.test.ts`

- [ ] **Step 1: Create `src/engine/server/package.json`**

```json
{
  "name": "@hdtw/engine-server",
  "version": "0.0.1",
  "private": true,
  "main": "./dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "@hdtw/engine-core": "workspace:*",
    "@hdtw/protocol": "workspace:*",
    "vscode-jsonrpc": "^8.2.1"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "typescript": "^5.8.3",
    "vitest": "^3.1.0"
  }
}
```

- [ ] **Step 2: Create `src/engine/server/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Install and build workspace dependencies**

Run: `pnpm install && pnpm turbo build --filter=@hdtw/engine-server^...`
Expected: `@hdtw/protocol` and `@hdtw/engine-core` build successfully (the server itself has no source yet).

- [ ] **Step 4: Write the failing unit test — `src/engine/server/src/pingHandler.test.ts`**

```ts
import { expect, test } from "vitest";
import { PROTOCOL_VERSION } from "@hdtw/protocol";
import { handlePing } from "./pingHandler";

test("handlePing returns engine identity and protocol version", () => {
  const result = handlePing({ clientName: "test", protocolVersion: PROTOCOL_VERSION });
  expect(result).toEqual({
    engineName: "hdtw-engine",
    engineVersion: "0.0.1",
    protocolVersion: PROTOCOL_VERSION,
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm --filter @hdtw/engine-server test`
Expected: FAIL — cannot find module `./pingHandler`.

- [ ] **Step 6: Write the handler — `src/engine/server/src/pingHandler.ts`**

```ts
import { getEngineInfo } from "@hdtw/engine-core";
import { PROTOCOL_VERSION, type PingParams, type PingResult } from "@hdtw/protocol";

export function handlePing(_params: PingParams): PingResult {
  const engineInfo = getEngineInfo();
  return {
    engineName: engineInfo.name,
    engineVersion: engineInfo.version,
    protocolVersion: PROTOCOL_VERSION,
  };
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @hdtw/engine-server test`
Expected: PASS (1 test). (The e2e test doesn't exist yet.)

- [ ] **Step 8: Write the failing e2e test — `src/engine/server/tests/server.e2e.test.ts`**

This spawns the built server binary and talks to it exactly the way a real client will.

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { PING_METHOD, PROTOCOL_VERSION, type PingResult } from "@hdtw/protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let serverProcess: ChildProcess | undefined;

afterEach(() => {
  serverProcess?.kill();
});

test("engine server responds to ping over stdio JSON-RPC", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!)
  );
  connection.listen();

  const result = await connection.sendRequest<PingResult>(PING_METHOD, {
    clientName: "e2e-test",
    protocolVersion: PROTOCOL_VERSION,
  });

  expect(result).toEqual({
    engineName: "hdtw-engine",
    engineVersion: "0.0.1",
    protocolVersion: PROTOCOL_VERSION,
  });
  connection.dispose();
});
```

- [ ] **Step 9: Run e2e test to verify it fails**

Run: `pnpm --filter @hdtw/engine-server build && pnpm --filter @hdtw/engine-server test`
Expected: unit test PASSES, e2e test FAILS — `dist/main.js` does not exist (build emits nothing for it yet since `main.ts` is missing, so spawn fails or the request hangs and times out).

- [ ] **Step 10: Write the server entrypoint — `src/engine/server/src/main.ts`**

```ts
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { PING_METHOD, type PingParams } from "@hdtw/protocol";
import { handlePing } from "./pingHandler";

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout)
);

connection.onRequest(PING_METHOD, (params: PingParams) => handlePing(params));

connection.listen();
```

- [ ] **Step 11: Build and run all server tests to verify they pass**

Run: `pnpm --filter @hdtw/engine-server build && pnpm --filter @hdtw/engine-server test`
Expected: PASS (2 tests — unit + e2e).

- [ ] **Step 12: Commit**

```bash
git add src/engine/server pnpm-lock.yaml
git commit -m "feat(engine-server): add stdio JSON-RPC server with ping handshake"
```

---

### Task 5: VS Code extension (thin client)

**Files:**
- Create: `src/clients/vscode/package.json`
- Create: `src/clients/vscode/tsconfig.json`
- Create: `src/clients/vscode/src/extension.ts`
- Create: `src/clients/vscode/.vscodeignore`

The extension has no automated tests yet (per spec, `@vscode/test-electron` is deferred); Task 6 verifies it manually end-to-end.

- [ ] **Step 1: Create `src/clients/vscode/package.json`**

```json
{
  "name": "hdtw-vscode",
  "displayName": "How Does This Work",
  "description": "Guided, rails-driven explanation of how a codebase works from entrypoint to exit.",
  "version": "0.0.1",
  "private": true,
  "publisher": "madeit",
  "engines": {
    "vscode": "^1.96.0"
  },
  "categories": ["Other"],
  "main": "./dist/extension.js",
  "activationEvents": ["onStartupFinished"],
  "contributes": {},
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src"
  },
  "dependencies": {
    "@hdtw/engine-server": "workspace:*",
    "@hdtw/protocol": "workspace:*",
    "vscode-jsonrpc": "^8.2.1"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "@types/vscode": "^1.96.0",
    "typescript": "^5.8.3"
  }
}
```

Note: `@hdtw/engine-server` is a dependency only so the client can *locate the server binary* via `require.resolve` — it never imports engine code. The protocol-only dependency rule applies to code-level imports.

- [ ] **Step 2: Create `src/clients/vscode/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node", "vscode"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `src/clients/vscode/.vscodeignore`**

```
src/
tsconfig.json
.turbo/
```

- [ ] **Step 4: Write the extension — `src/clients/vscode/src/extension.ts`**

```ts
import * as childProcess from "node:child_process";
import * as vscode from "vscode";
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  PING_METHOD,
  PROTOCOL_VERSION,
  type PingParams,
  type PingResult,
} from "@hdtw/protocol";

const HANDSHAKE_TIMEOUT_MS = 5000;

let engineProcess: childProcess.ChildProcess | undefined;
let engineConnection: MessageConnection | undefined;

export async function activate(_context: vscode.ExtensionContext): Promise<void> {
  try {
    const result = await connectToEngine();
    void vscode.window.showInformationMessage(
      `HDTW engine connected (${result.engineName} v${result.engineVersion}, protocol v${result.protocolVersion})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`HDTW engine failed to start: ${message}`);
  }
}

async function connectToEngine(): Promise<PingResult> {
  // Resolves to the engine-server package's "main" (dist/main.js) via the
  // workspace symlink. The client never imports engine code — it only needs
  // the path to spawn the process.
  const serverEntry = require.resolve("@hdtw/engine-server");

  // The extension host is Electron; ELECTRON_RUN_AS_NODE makes the spawned
  // process behave as plain Node.js (same technique vscode-languageclient uses).
  engineProcess = childProcess.spawn(process.execPath, [serverEntry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (!engineProcess.stdout || !engineProcess.stdin) {
    throw new Error("engine process has no stdio streams");
  }

  engineConnection = createMessageConnection(
    new StreamMessageReader(engineProcess.stdout),
    new StreamMessageWriter(engineProcess.stdin)
  );
  engineConnection.listen();

  const params: PingParams = {
    clientName: "vscode",
    protocolVersion: PROTOCOL_VERSION,
  };
  const ping = engineConnection.sendRequest<PingResult>(PING_METHOD, params);
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new Error(`engine handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`)),
      HANDSHAKE_TIMEOUT_MS
    );
  });
  return Promise.race([ping, timeout]);
}

export function deactivate(): void {
  engineConnection?.dispose();
  engineConnection = undefined;
  engineProcess?.kill();
  engineProcess = undefined;
}
```

- [ ] **Step 5: Install and build the full workspace**

Run: `pnpm install && pnpm build`
Expected: all four packages build in dependency order (protocol → core → server → vscode), exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/clients/vscode pnpm-lock.yaml
git commit -m "feat(vscode): add thin client extension with engine handshake"
```

---

### Task 6: F5 launch configuration and manual end-to-end verification

**Files:**
- Create: `.vscode/launch.json`
- Create: `.vscode/tasks.json`

- [ ] **Step 1: Create `.vscode/launch.json`**

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}/src/clients/vscode"],
      "preLaunchTask": "build"
    }
  ]
}
```

- [ ] **Step 2: Create `.vscode/tasks.json`**

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "pnpm build",
      "group": "build",
      "problemMatcher": ["$tsc"]
    }
  ]
}
```

- [ ] **Step 3: Manual verification — F5**

1. Open the repo root in VS Code.
2. Press F5 ("Run Extension"). A new Extension Development Host window opens.
3. Expected: notification **"HDTW engine connected (hdtw-engine v0.0.1, protocol v0.0.1)"** appears shortly after the window loads.

If executing this plan as an agent without a display: skip the click-through, note it for the human, and verify the handshake path is already covered by the engine-server e2e test.

- [ ] **Step 4: Negative check (error path)**

Temporarily rename `src/engine/server/dist/main.js` to `main.js.bak`, press F5 again — expected: error notification "HDTW engine failed to start: …". Restore the file afterwards (`pnpm build` also restores it). Skip if running headless.

- [ ] **Step 5: Commit**

```bash
git add .vscode
git commit -m "chore: add F5 extension launch configuration"
```

---

### Task 7: Lint pass and AGENTS.md current-state update

**Files:**
- Modify: `AGENTS.md` (the "Current state" and "Commands" sections)

- [ ] **Step 1: Run lint across the workspace and fix anything it reports**

Run: `pnpm lint`
Expected: all packages pass. If typescript-eslint flags the non-null assertions in `server.e2e.test.ts` or unused-var patterns like `_params`, fix by configuring the rule rather than weakening the code:

Add to `eslint.config.mjs` (after the recommended configs) only if needed:

```js
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  }
```

- [ ] **Step 2: Run the full verification suite**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: builds clean, 4 tests pass (protocol 1, core 1, server unit 1 + e2e 1), lint clean.

- [ ] **Step 3: Update `AGENTS.md`**

In the **Current state** section, replace the "scaffold does not exist yet" bullet with:

```markdown
- **Runnable skeleton implemented** (plan: `docs/superpowers/plans/2026-06-12-monorepo-skeleton.md`): `pnpm install && pnpm build` works; F5 in VS Code launches the extension, which spawns the engine and completes the ping/pong handshake.
```

In the **Commands** section, replace the command block with the working forms:

```bash
pnpm install                              # install all workspace deps
pnpm build                                # turbo build, dependency order
pnpm test                                 # turbo test (builds first)
pnpm lint                                 # turbo lint
pnpm turbo test --filter=@hdtw/engine-core            # test one package
pnpm --filter @hdtw/engine-server exec vitest run tests/server.e2e.test.ts  # single test file
```

Also note the extension package naming deviation: the VS Code extension package is `hdtw-vscode` (not `@hdtw/vscode`) because extension manifests cannot use npm scopes.

- [ ] **Step 4: Create the ADR directory from the spec layout**

```bash
mkdir -p docs/adr && touch docs/adr/.gitkeep
```

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/adr/.gitkeep
git commit -m "docs: mark runnable skeleton as implemented in AGENTS.md"
```
