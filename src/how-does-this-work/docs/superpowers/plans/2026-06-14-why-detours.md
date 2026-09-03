# "Why?" Detours Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During a walk, the user replies to the narration thread with a follow-up; the engine's read-only, capped agent answers (grounded in the step), and a "🧠 thinking…" placeholder is replaced by the answer in the thread. Ephemeral — navigating disposes it.

**Architecture:** A new `hdtw/askAboutStep` runs a `StepAnswerer` (Claude Agent SDK, read-only tools, `maxTurns: 6`) behind the same abort/budget orchestration as generation, returning prose. The VS Code client enables thread replies (Comments API), routes the reply to the engine via a cancellable `withProgress`, and swaps the placeholder for the answer — all thread manipulation in the WalkController, the engine call injected. Spec: `docs/superpowers/specs/2026-06-14-why-detours-design.md`.

**Tech Stack:** existing monorepo stack + the already-installed `@anthropic-ai/claude-agent-sdk`. New VS Code usage: Comments API replies (`CommentController.options`, `comments/commentThread/context` menu, `CommentReply`).

**Conventions:** `@made-i-t/hdtw-*` scope; `.js` relative imports; engine-core untouched (pure); the engine never trusts agent data (the answer is plain, non-trusted markdown; the agent is read-only + capped); observability via the injected observer; clients import code only from the protocol package; tests co-located/excluded from build; commands run from repo root. Reuse the generation error classes (`AuthRequiredError`/`BudgetExceededError`/`GenerationCancelledError`/`GenerationFailedError`) and `GenerationHooks` from `tourGenerator.ts`.

---

### Task 1: Protocol — `askAboutStep` method + types + `"answering"` phase

**Files:**

- Modify: `src/protocol/src/generation.ts`
- Test: `src/protocol/src/askAboutStep.test.ts`

- [ ] **Step 1: Write the failing test — `src/protocol/src/askAboutStep.test.ts`**

```ts
import { expect, test } from "vitest";
import { ASK_ABOUT_STEP_METHOD } from "./index.js";

test("askAboutStep method name is stable", () => {
  expect(ASK_ABOUT_STEP_METHOD).toBe("hdtw/askAboutStep");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-protocol test`
Expected: FAIL — constant not exported.

- [ ] **Step 3: Edit `src/protocol/src/generation.ts`.**

(a) Add `"answering"` to the `GenerationPhase` union. Change it to:

```ts
export type GenerationPhase =
  "exploring" | "drafting" | "verifying" | "repairing" | "saving" | "answering";
```

(b) Append the askAboutStep contract at the end of the file:

```ts
/** JSON-RPC method: client→engine, answer a follow-up question about the current tour step. */
export const ASK_ABOUT_STEP_METHOD = "hdtw/askAboutStep";

export interface StepQaContext {
  file: string;
  startLine: number;
  endLine: number;
  narration: string;
  tourTitle?: string;
}

export interface AskAboutStepParams {
  workspaceRoot: string;
  question: string;
  context: StepQaContext;
  model?: string;
  maxBudgetUsd?: number;
}

export interface AskAboutStepResult {
  answer: string;
}
```

- [ ] **Step 4: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-protocol test && pnpm --filter @made-i-t/hdtw-protocol build`
Expected: all pass; build exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/protocol
git commit -m "feat(protocol): add askAboutStep method, StepQaContext, answering phase"
```

---

### Task 2: engine-server — `StepAnswerer` port, prompt builder, fake + Claude answerers

**Files:**

- Create: `src/engine/server/src/stepAnswerer.ts`
- Create: `src/engine/server/src/fakeStepAnswerer.ts`
- Create: `src/engine/server/src/claudeStepAnswerer.ts`
- Test: `src/engine/server/src/stepAnswerer.test.ts`

- [ ] **Step 1: Write `src/engine/server/src/stepAnswerer.ts`** (port + pure prompt builder + Q&A system prompt)

```ts
import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import type { GenerationHooks } from "./tourGenerator.js";

export interface StepAnswerer {
  answer(
    workspaceRoot: string,
    context: StepQaContext,
    question: string,
    model: string | undefined,
    hooks: GenerationHooks,
  ): Promise<string>;
}

export const STEP_ANSWER_SYSTEM_PROMPT = `You are a principal engineer answering a teammate's follow-up question about a specific piece of code they are looking at during a guided code tour.

- Answer in Markdown, concisely — a short paragraph, occasionally a tiny snippet.
- Ground every claim in code you actually read with your tools: read the anchored file, and follow references (Grep/Glob/Read) only as far as needed to answer.
- If the question is outside the scope of this code, say so briefly rather than speculating.`;

/** Pure: build the user prompt from the step context + question. */
export function buildStepAnswerPrompt(
  context: StepQaContext,
  question: string,
): string {
  return `A teammate paused on this step of the tour "${context.tourTitle ?? "(untitled)"}".

File: ${context.file} (lines ${context.startLine}-${context.endLine})

The step's narration:
"""
${context.narration}
"""

Their follow-up question:
"""
${question}
"""

Read the anchored code (follow references if needed) and answer it.`;
}
```

- [ ] **Step 2: Write the failing test — `src/engine/server/src/stepAnswerer.test.ts`**

```ts
import { describe, expect, test } from "vitest";
import { buildStepAnswerPrompt } from "./stepAnswerer.js";

describe("buildStepAnswerPrompt", () => {
  const context = {
    file: "src/main.ts",
    startLine: 10,
    endLine: 20,
    narration: "stdio JSON-RPC.",
    tourTitle: "Architecture",
  };
  test("embeds the file, range, narration, and question", () => {
    const prompt = buildStepAnswerPrompt(context, "why stdio?");
    expect(prompt).toContain("src/main.ts (lines 10-20)");
    expect(prompt).toContain("stdio JSON-RPC.");
    expect(prompt).toContain("why stdio?");
    expect(prompt).toContain("Architecture");
  });
  test("tolerates a missing tour title", () => {
    const prompt = buildStepAnswerPrompt(
      { ...context, tourTitle: undefined },
      "q",
    );
    expect(prompt).toContain("(untitled)");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: FAIL — `stepAnswerer.js` not found.

- [ ] **Step 4: Write `src/engine/server/src/fakeStepAnswerer.ts`**

```ts
import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import type { GenerationHooks } from "./tourGenerator.js";
import { GenerationCancelledError } from "./tourGenerator.js";
import type { StepAnswerer } from "./stepAnswerer.js";

export interface FakeStepAnswererOptions {
  answer?: string;
  costPerEvent?: number;
}

export class FakeStepAnswerer implements StepAnswerer {
  constructor(private readonly options: FakeStepAnswererOptions = {}) {}

  async answer(
    _workspaceRoot: string,
    _context: StepQaContext,
    question: string,
    _model: string | undefined,
    hooks: GenerationHooks,
  ): Promise<string> {
    hooks.onProgress({
      phase: "answering",
      message: "Answering",
      tokensIn: 500,
      tokensOut: 200,
      estimatedCostUsd: this.options.costPerEvent ?? 0.01,
    });
    if (hooks.signal.aborted) {
      throw new GenerationCancelledError("answer aborted");
    }
    return this.options.answer ?? `Fake answer to: ${question}`;
  }
}
```

- [ ] **Step 5: Write `src/engine/server/src/claudeStepAnswerer.ts`**

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StepQaContext } from "@made-i-t/hdtw-protocol";
import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type GenerationHooks,
} from "./tourGenerator.js";
import {
  buildStepAnswerPrompt,
  STEP_ANSWER_SYSTEM_PROMPT,
  type StepAnswerer,
} from "./stepAnswerer.js";

const ESTIMATED_USD_PER_INPUT_TOKEN = 3 / 1_000_000;
const ESTIMATED_USD_PER_OUTPUT_TOKEN = 15 / 1_000_000;
const MAX_ANSWER_TURNS = 6;

export class ClaudeStepAnswerer implements StepAnswerer {
  async answer(
    workspaceRoot: string,
    context: StepQaContext,
    question: string,
    model: string | undefined,
    hooks: GenerationHooks,
  ): Promise<string> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    hooks.signal.addEventListener("abort", onAbort, { once: true });

    let tokensIn = 0;
    let tokensOut = 0;
    let resultText: string | undefined;

    try {
      const response = query({
        prompt: buildStepAnswerPrompt(context, question),
        options: {
          cwd: workspaceRoot,
          model,
          maxTurns: MAX_ANSWER_TURNS,
          tools: ["Read", "Grep", "Glob"],
          systemPrompt: STEP_ANSWER_SYSTEM_PROMPT,
          abortController,
        },
      });

      for await (const message of response) {
        if (message.type === "assistant") {
          const usage = message.message.usage;
          tokensIn += usage?.input_tokens ?? 0;
          tokensOut += usage?.output_tokens ?? 0;
          hooks.observer.logger.debug("qa.usage", { tokensIn, tokensOut });
          hooks.onProgress({
            phase: "answering",
            message: "Answering your question",
            tokensIn,
            tokensOut,
            estimatedCostUsd:
              tokensIn * ESTIMATED_USD_PER_INPUT_TOKEN
              + tokensOut * ESTIMATED_USD_PER_OUTPUT_TOKEN,
          });
        }
        if (message.type === "result") {
          if (message.subtype === "success") {
            resultText = message.result;
          } else {
            throw new GenerationFailedError(
              `agent run ended without a result (${message.subtype})`,
            );
          }
        }
      }
    } catch (error) {
      if (hooks.signal.aborted) {
        throw new GenerationCancelledError("answer aborted");
      }
      if (isAuthError(error)) {
        throw new AuthRequiredError(
          "No Anthropic credentials found. Set an API key (HDTW: Set Anthropic API Key) or log in to Claude Code.",
        );
      }
      throw error;
    } finally {
      hooks.signal.removeEventListener("abort", onAbort);
    }

    if (resultText === undefined || resultText.trim().length === 0) {
      throw new GenerationFailedError("the agent produced no answer");
    }
    return resultText;
  }
}

function isAuthError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|not logged in|credential|billing/i.test(
    text,
  );
}
```

(If the installed SDK's message/usage field names differ, adapt as the generation generator did and report.)

- [ ] **Step 6: Run tests and build**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: build clean; tests pass (+2 buildStepAnswerPrompt). Report count.

- [ ] **Step 7: Commit**

```bash
git add src/engine/server/src/stepAnswerer.ts src/engine/server/src/fakeStepAnswerer.ts src/engine/server/src/claudeStepAnswerer.ts src/engine/server/src/stepAnswerer.test.ts
git commit -m "feat(engine-server): add StepAnswerer port, prompt builder, fake + Claude answerers"
```

---

### Task 3: engine-server — `runStepAnswer` orchestration + `askAboutStep` handler + e2e

**Files:**

- Create: `src/engine/server/src/stepAnswerPipeline.ts`
- Modify: `src/engine/server/src/main.ts`
- Test: `src/engine/server/tests/askAboutStep.e2e.test.ts`

- [ ] **Step 1: Write `src/engine/server/src/stepAnswerPipeline.ts`** (budget/abort orchestration + answerer selection — mirrors `runGeneration`'s abort/budget shape)

```ts
import type {
  AskAboutStepParams,
  AskAboutStepResult,
  GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";
import type { Observer } from "@made-i-t/hdtw-observability";
import {
  BudgetExceededError,
  GenerationCancelledError,
  type GenerationHooks,
  type StepAnswerer,
} from "./tourGenerator.js";
import { FakeStepAnswerer } from "./fakeStepAnswerer.js";
import { ClaudeStepAnswerer } from "./claudeStepAnswerer.js";

const DEFAULT_MAX_BUDGET_USD = 2;

export function createStepAnswerer(): StepAnswerer {
  return process.env.HDTW_GENERATOR === "fake"
    ? new FakeStepAnswerer()
    : new ClaudeStepAnswerer();
}

export async function runStepAnswer(
  params: AskAboutStepParams,
  answerer: StepAnswerer,
  observer: Observer,
  onProgress: (progress: GenerationProgressParams) => void,
  cancelSignal: AbortSignal,
): Promise<AskAboutStepResult> {
  const maxBudgetUsd = params.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD;
  const abort = new AbortController();
  let budgetBreachedAtUsd: number | undefined;

  if (cancelSignal.aborted) {
    throw new GenerationCancelledError("answer cancelled");
  }
  const forwardAbort = () => abort.abort();
  cancelSignal.addEventListener("abort", forwardAbort, { once: true });

  observer.logger.info("qa.asked", {
    file: params.context.file,
    question: params.question,
  });

  try {
    const hooks: GenerationHooks = {
      signal: abort.signal,
      observer,
      onProgress: (progress) => {
        onProgress(progress);
        if (progress.estimatedCostUsd > maxBudgetUsd
            && budgetBreachedAtUsd === undefined
        ) {
          budgetBreachedAtUsd = progress.estimatedCostUsd;
          abort.abort();
        }
      },
    };

    let answer: string;
    try {
      answer = await answerer.answer(
        params.workspaceRoot,
        params.context,
        params.question,
        params.model && params.model.trim().length > 0
          ? params.model
          : undefined,
        hooks,
      );
    } catch (error) {
      if (budgetBreachedAtUsd !== undefined) {
        throw new BudgetExceededError(
          `answer aborted: estimated cost $${budgetBreachedAtUsd.toFixed(2)} exceeded budget $${maxBudgetUsd.toFixed(2)}`,
          budgetBreachedAtUsd,
        );
      }
      if (cancelSignal.aborted || abort.signal.aborted) {
        throw new GenerationCancelledError("answer cancelled");
      }
      throw error;
    }

    observer.logger.info("qa.answered", { chars: answer.length });
    return { answer };
  } finally {
    cancelSignal.removeEventListener("abort", forwardAbort);
  }
}
```

(NOTE: `StepAnswerer` is re-exported below from `tourGenerator.js` per Step 2 — adjust the import if you instead import it from `./stepAnswerer.js`. Prefer importing `StepAnswerer` from `./stepAnswerer.js` and the error classes + `GenerationHooks` from `./tourGenerator.js`.)

Correct the imports to:

```ts
import {
  BudgetExceededError,
  GenerationCancelledError,
  type GenerationHooks,
} from "./tourGenerator.js";
import type { StepAnswerer } from "./stepAnswerer.js";
import { FakeStepAnswerer } from "./fakeStepAnswerer.js";
import { ClaudeStepAnswerer } from "./claudeStepAnswerer.js";
```

- [ ] **Step 2: Write the failing e2e — `src/engine/server/tests/askAboutStep.e2e.test.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  ASK_ABOUT_STEP_METHOD,
  GENERATION_PROGRESS_NOTIFICATION,
  type AskAboutStepResult,
  type GenerationProgressParams,
} from "@made-i-t/hdtw-protocol";

const serverEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let serverProcess: ChildProcess | undefined;
let connection: MessageConnection | undefined;
let workspaceRoot: string;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-qa-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture\n");
});
afterEach(async () => {
  connection?.dispose();
  connection = undefined;
  serverProcess?.kill();
  serverProcess = undefined;
  await rm(workspaceRoot, { recursive: true, force: true });
});

test("askAboutStep returns an answer and emits an answering progress event", async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, HDTW_GENERATOR: "fake" },
  });
  connection = createMessageConnection(
    new StreamMessageReader(serverProcess.stdout!),
    new StreamMessageWriter(serverProcess.stdin!),
  );
  const progress: GenerationProgressParams[] = [];
  connection.onNotification(
    GENERATION_PROGRESS_NOTIFICATION,
    (p: GenerationProgressParams) => progress.push(p),
  );
  connection.listen();

  const result = await connection.sendRequest<AskAboutStepResult>(
    ASK_ABOUT_STEP_METHOD,
    {
      workspaceRoot,
      question: "why stdio?",
      context: {
        file: "README.md",
        startLine: 1,
        endLine: 1,
        narration: "n",
        tourTitle: "T",
      },
    },
  );

  expect(result.answer).toBe("Fake answer to: why stdio?");
  expect(progress.map((p) => p.phase)).toContain("answering");
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: the e2e FAILS ("Unhandled method hdtw/askAboutStep").

- [ ] **Step 4: Register in `src/engine/server/src/main.ts`.** Add to the protocol import block: `ASK_ABOUT_STEP_METHOD`, `type AskAboutStepParams`. Add `import { createStepAnswerer, runStepAnswer } from "./stepAnswerPipeline.js";`. Register after the `GENERATE_TOUR_METHOD` handler (it reuses the same generation error classes already imported + `REQUEST_CANCELLED_ERROR_CODE`):

```ts
connection.onRequest(
  ASK_ABOUT_STEP_METHOD,
  async (params: AskAboutStepParams, token: CancellationToken) => {
    const abort = new AbortController();
    const cancelSubscription = token.onCancellationRequested(() =>
      abort.abort(),
    );
    try {
      return await runStepAnswer(
        params,
        createStepAnswerer(),
        observer,
        (progress) =>
          connection.sendNotification(
            GENERATION_PROGRESS_NOTIFICATION,
            progress,
          ),
        abort.signal,
      );
    } catch (error) {
      if (error instanceof GenerationCancelledError) {
        throw new ResponseError(
          REQUEST_CANCELLED_ERROR_CODE,
          "answer cancelled",
        );
      }
      if (error instanceof AuthRequiredError) {
        throw new ResponseError(
          GENERATION_AUTH_REQUIRED_ERROR_CODE,
          error.message,
        );
      }
      if (error instanceof BudgetExceededError) {
        throw new ResponseError(
          GENERATION_BUDGET_EXCEEDED_ERROR_CODE,
          error.message,
        );
      }
      if (error instanceof GenerationFailedError) {
        throw new ResponseError(GENERATION_FAILED_ERROR_CODE, error.message);
      }
      throw error;
    } finally {
      cancelSubscription.dispose();
    }
  },
);
```

(All those error classes / codes / `REQUEST_CANCELLED_ERROR_CODE` / `CancellationToken` are already imported in main.ts from the generation wiring.)

- [ ] **Step 5: Build and run**

Run: `pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server test`
Expected: all pass (+1 askAboutStep e2e). Report count.

- [ ] **Step 6: Commit**

```bash
git add src/engine/server/src/stepAnswerPipeline.ts src/engine/server/src/main.ts src/engine/server/tests/askAboutStep.e2e.test.ts
git commit -m "feat(engine-server): add askAboutStep over stdio with budget + cancellation"
```

---

### Task 4: VS Code — client method + WalkController reply handling

**Files:**

- Modify: `src/clients/vscode/src/engineClient.ts`
- Modify: `src/clients/vscode/src/walkController.ts`

- [ ] **Step 1: Add `askAboutStep` to `EngineClient`.** Extend the protocol import with `ASK_ABOUT_STEP_METHOD`, `type AskAboutStepParams`, `type AskAboutStepResult`, `type GenerationProgressParams` (if not already imported). Mirror `generateTour`'s progress-subscription + cancellation wiring. Add after `generateTour`:

```ts
  async askAboutStep(
    params: AskAboutStepParams,
    onProgress: (progress: GenerationProgressParams) => void,
    cancellation: { onCancellationRequested(listener: () => void): { dispose(): void } }
  ): Promise<AskAboutStepResult> {
    if (!this.connection) {
      throw new Error("engine not connected");
    }
    const progressSubscription = this.connection.onNotification(
      GENERATION_PROGRESS_NOTIFICATION,
      onProgress
    );
    const source = new CancellationTokenSource();
    const cancelSubscription = cancellation.onCancellationRequested(() => source.cancel());
    try {
      return await this.connection.sendRequest<AskAboutStepResult>(
        ASK_ABOUT_STEP_METHOD,
        params,
        source.token
      );
    } finally {
      progressSubscription.dispose();
      cancelSubscription.dispose();
      source.dispose();
    }
  }
```

(`CancellationTokenSource` and `GENERATION_PROGRESS_NOTIFICATION` are already imported in this file from `generateTour`.)

- [ ] **Step 2: Extend `WalkController` (`src/clients/vscode/src/walkController.ts`).**

(a) Add the import:

```ts
import type { StepQaContext } from "@made-i-t/hdtw-protocol";
```

(b) In the constructor, after creating the comment controller, set the reply prompt:

```ts
this.commentController.options = {
  prompt: "Ask a follow-up about this step…",
  placeHolder: "e.g. why is it done this way?",
};
```

(c) Enable replies: change `this.thread.canReply = false;` (in `renderCurrentStep`) to `this.thread.canReply = true;`.

(d) Add `activeStepContext` + `askWhy` methods (near the other public methods):

```ts
  activeStepContext(): StepQaContext | undefined {
    if (this.stack.length === 0) {
      return undefined;
    }
    const active = activeWalk(this.stack);
    const step = currentStep(active);
    return {
      file: step.anchor.file,
      startLine: step.anchor.startLine,
      endLine: step.anchor.endLine,
      narration: step.narration,
      tourTitle: active.tour.title,
    };
  }

  /** Append the question + a thinking placeholder to the active thread, then swap in the answer. */
  async askWhy(question: string, answer: (ctx: StepQaContext) => Promise<string>): Promise<void> {
    const thread = this.thread;
    const ctx = this.activeStepContext();
    if (!thread || !ctx) {
      return;
    }
    const youComment: vscode.Comment = {
      body: new vscode.MarkdownString(question),
      mode: vscode.CommentMode.Preview,
      author: { name: "You" },
    };
    const thinking: vscode.Comment = {
      body: new vscode.MarkdownString("🧠 _thinking…_"),
      mode: vscode.CommentMode.Preview,
      author: { name: "🧠 HDTW" },
    };
    thread.comments = [...thread.comments, youComment, thinking];

    let answerComment: vscode.Comment;
    try {
      const text = await answer(ctx);
      // Plain (non-trusted) markdown — an answer must never carry executable command links.
      answerComment = {
        body: new vscode.MarkdownString(text),
        mode: vscode.CommentMode.Preview,
        author: { name: "🧠 HDTW" },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      answerComment = {
        body: new vscode.MarkdownString(`⚠️ ${message}`),
        mode: vscode.CommentMode.Preview,
        author: { name: "🧠 HDTW" },
      };
    }
    // Only apply if the user hasn't navigated away (the thread is still the active one).
    if (this.thread === thread) {
      thread.comments = [...thread.comments.slice(0, -1), answerComment];
    }
  }
```

- [ ] **Step 3: Verify build (no behavior change yet without the command wiring).**

Run: `pnpm build && pnpm test`
Expected: build clean; tests unchanged (vscode count unchanged — no new unit tests this task). Report counts.

- [ ] **Step 4: Commit**

```bash
git add src/clients/vscode/src/engineClient.ts src/clients/vscode/src/walkController.ts
git commit -m "feat(vscode): repliable narration thread + askWhy on the walk controller"
```

---

### Task 5: VS Code — reply command + manifest wiring

**Files:**

- Modify: `src/clients/vscode/package.json`
- Modify: `src/clients/vscode/src/extension.ts`

- [ ] **Step 1: Manifest — `src/clients/vscode/package.json`.**

(a) Add the command to `contributes.commands`:

```json
{ "command": "hdtw.askWhy", "title": "HDTW: Ask About This Step" }
```

(b) Add a `comments/commentThread/context` menu so the reply box shows a submit button on the tour's threads (add the key to `contributes.menus` if absent):

```json
      "comments/commentThread/context": [
        { "command": "hdtw.askWhy", "when": "commentController == hdtw-tour", "group": "inline" }
      ]
```

- [ ] **Step 2: Wire `src/clients/vscode/src/extension.ts`.**

(a) Register the command in the `context.subscriptions.push(...)` block:

```ts
    vscode.commands.registerCommand("hdtw.askWhy", (reply: vscode.CommentReply) => askWhy(reply)),
```

(b) Add the `askWhy` function (near `followRelated`/`reanchorStep`):

```ts
async function askWhy(reply: vscode.CommentReply): Promise<void> {
  const root = workspaceRoot();
  const question = reply.text.trim();
  if (!root || !client || !walk || question.length === 0) {
    return;
  }
  observer?.logger.info("qa.asked", { question });
  const config = vscode.workspace.getConfiguration("hdtw.generation");
  const model = config.get<string>("model", "");
  const maxBudgetUsd = config.get<number>("maxBudgetUsd", 2);
  await walk.askWhy(question, (ctx) =>
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "HDTW: answering",
        cancellable: true,
      },
      async (progress, token) => {
        const { answer } = await client!.askAboutStep(
          {
            workspaceRoot: root,
            question,
            context: ctx,
            model: model || undefined,
            maxBudgetUsd,
          },
          (update) =>
            progress.report({
              message: `${update.message} (${Math.round((update.tokensIn + update.tokensOut) / 1000)}k tokens · ~$${update.estimatedCostUsd.toFixed(2)})`,
            }),
          token,
        );
        return answer;
      },
    ),
  );
}
```

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: build clean; all tests pass (report counts); lint clean; manifest valid JSON.

- [ ] **Step 4: Commit**

```bash
git add src/clients/vscode
git commit -m "feat(vscode): Why-detour reply command wired to askAboutStep"
```

---

### Task 6: Docs

**Files:**

- Modify: `docs/product-roadmap.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Roadmap.** Change the Chunk 3b heading from `🔄 spec'd, next up` to `✅ shipped 2026-06-14`. If there's a "V1 complete" marker, you may note V1 (chunks 1–3) is now complete.

- [ ] **Step 2: AGENTS.md Current state.** Add after the Conversational Ask (3a) bullet:

```markdown
- **"Why?" detours shipped (Chunk 3b) — V1 complete:** the narration thread is repliable; a reply routes to `hdtw/askAboutStep` (a read-only, `maxTurns:6` agent grounded in the step's file/anchor/narration), shows a "🧠 thinking…" placeholder, then the answer — ephemeral, disposed on navigate. Engine: `StepAnswerer` port (Claude + fake via `HDTW_GENERATOR=fake`) + `runStepAnswer` (budget/cancel like generation). Answers render as non-trusted markdown (no command links).
```

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test && pnpm lint`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/product-roadmap.md AGENTS.md
git commit -m "docs: mark Why detours (chunk 3b) shipped; V1 complete"
```

- [ ] **Step 5: Human F5 dogfood (flag in report)**

1. F5 → walk a tour. The narration thread now shows a reply box ("Ask a follow-up about this step…").
2. Type "why is it done this way?" and submit → your question + "🧠 thinking…" appear; a progress notification shows tokens/cost.
3. The placeholder is replaced by a grounded answer.
4. Press **Next** → the Q&A is gone (ephemeral) and the walk continues.
5. (No-auth check) With no key + no Claude Code login, asking shows the "Set your Anthropic API key" message in the thread.

```

```
