# OpenAI-Compatible BYOM (Generation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second tour-generation backend (`OpenAiAgentTourGenerator`) behind the existing `TourGenerator` port that drives any OpenAI-compatible endpoint (OpenAI, OpenRouter, Gemini-compat, local Ollama), so authors can generate tours with a non-Claude model.

**Architecture:** Extract the generation prompt/JSON-parse and a provider-agnostic read-only tool layer out of `claudeTourGenerator`, then build a new generator that runs a manual OpenAI tool-calling explore loop over those shared tools. A provider-selection factory and additive `GenerateTourParams`/VS Code config route requests. Engine-core and the verify/repair/symbol/drift pipeline are untouched — every backend only produces a `DraftTour`; the engine owns verification.

**Tech Stack:** TypeScript (engine-server is ESM, `.js` import suffixes), `openai` npm SDK (base-URL configurable), Vitest. Reuses Chunk 4b `runFileOutlineTool`/`runFindSymbolTool`.

---

## Locked existing shapes (from `src/engine/server/src/`)

- `tourGenerator.ts`: `interface TourGenerator { generate(workspaceRoot, topic, model, catalog, hooks): Promise<DraftTour>; repair(workspaceRoot, topic, model, catalog, draft, anchorErrors, hooks): Promise<DraftTour> }`. `GenerationHooks { onProgress(GenerationProgressParams): void; signal: AbortSignal; observer: Observer }`. Errors: `AuthRequiredError`, `GenerationFailedError`, `BudgetExceededError(message, spentUsd)`, `GenerationCancelledError`. `DraftTour/DraftStep/DraftAnchor` (anchor has optional `startLine/endLine/symbol`).
- `claudeTourGenerator.ts` exports `parseDraft(resultText): DraftTour` (extracts the LAST ` ```json ` fence → `JSON.parse` → `validateDraft`, which already accepts symbol- AND line-anchors). It also has module-private `SYSTEM_PROMPT`, `catalogSection(catalog)`, `isAuthError(error)`, `validateDraft(value)`, and `ESTIMATED_USD_PER_INPUT_TOKEN`/`ESTIMATED_USD_PER_OUTPUT_TOKEN`.
- `codemapTools.ts` exports `runFileOutlineTool(workspaceRoot, file)` and `runFindSymbolTool(workspaceRoot, file, name)` (path-guarded, always return text).
- `main.ts:62` `function createGenerator(): TourGenerator { return process.env.HDTW_GENERATOR === "fake" ? new FakeTourGenerator() : new ClaudeAgentTourGenerator(); }` — the provider-selection seam. The `GENERATE_TOUR_METHOD` handler calls `runGeneration(params, createGenerator(), observer, onProgress, abort.signal)`.

---

## Task 1: Extract shared generation prompt + parse into `generationPrompt.ts`

**Files:**

- Create: `src/engine/server/src/generationPrompt.ts`
- Modify: `src/engine/server/src/claudeTourGenerator.ts`
- Create: `src/engine/server/src/generationPrompt.test.ts`

- [ ] **Step 1: Create `generationPrompt.ts` by MOVING the shared pieces out of `claudeTourGenerator.ts`.** Read `claudeTourGenerator.ts` first. Move these VERBATIM into the new file and `export` them: the `SYSTEM_PROMPT` const, `catalogSection`, `parseDraft`, `validateDraft`, and add a `repairPrompt` builder extracted from the repair-prompt string currently inline in `ClaudeAgentTourGenerator.repair`. The new file:

```ts
import { GenerationFailedError, type DraftTour } from "./tourGenerator.js";
import type { TourSummary } from "@made-i-t/hdtw-protocol";

export const SYSTEM_PROMPT = `...`; // <- MOVE the exact existing string verbatim

export function catalogSection(catalog: TourSummary[]): string {
  /* MOVE verbatim */
}

/** User prompt for a fresh generation. */
export function generatePrompt(topic: string, catalog: TourSummary[]): string {
  return `Create a guided tour for this topic: ${topic}${catalogSection(catalog)}`;
}

/** User prompt for the one repair round. */
export function repairPrompt(
  topic: string,
  draft: DraftTour,
  anchorErrors: string[],
): string {
  return `You previously drafted this tour for the topic "${topic}":

\`\`\`json
${JSON.stringify(draft, null, 2)}
\`\`\`

These anchors failed verification against the actual files:
${anchorErrors.map((error) => `- ${error}`).join("\n")}

Re-read the affected files, fix ONLY the broken anchors (adjust line ranges, switch to a symbol anchor, or choose a better location), and output the corrected complete tour in the required fenced JSON format.`;
}

export function parseDraft(resultText: string): DraftTour {
  /* MOVE verbatim */
}
function validateDraft(value: unknown): string[] {
  /* MOVE verbatim */
}
```

> Match the EXACT current text of `SYSTEM_PROMPT`, `catalogSection`, `parseDraft`, `validateDraft`, and the repair prompt (compare against the strings currently in `claudeTourGenerator.ts` — do not paraphrase). `generatePrompt`/`repairPrompt` capture the two user-prompt strings the Claude generator builds inline today.

- [ ] **Step 2: Update `claudeTourGenerator.ts` to import the shared pieces.** Remove the moved definitions; import `{ SYSTEM_PROMPT, generatePrompt, repairPrompt, parseDraft } from "./generationPrompt.js"`. In `generate`, build the prompt via `generatePrompt(topic, catalog)`; in `repair`, via `repairPrompt(topic, draft, anchorErrors)`. Keep `isAuthError` and the cost constants where they are (Claude-specific). The behavior must be byte-identical.

- [ ] **Step 3: Move/author the parse test.** Create `generationPrompt.test.ts`:

````ts
import { expect, test } from "vitest";
import { parseDraft } from "./generationPrompt.js";

test("parseDraft extracts the last fenced JSON block and validates a symbol-anchor draft", () => {
  const text =
    "thinking...\n```json\n"
    + JSON.stringify({
      title: "T",
      summary: "S",
      steps: [
        { title: "a", narration: "n", anchor: { file: "x.ts", symbol: "foo" } },
      ],
    })
    + "\n```\n";
  const draft = parseDraft(text);
  expect(draft.title).toBe("T");
  expect(draft.steps[0].anchor).toMatchObject({ file: "x.ts", symbol: "foo" });
});

test("parseDraft rejects non-JSON and malformed drafts", () => {
  expect(() => parseDraft("no json here")).toThrow();
  expect(() => parseDraft('```json\n{"title":""}\n```')).toThrow();
});
````

If a `parseDraft` test already exists in `claudeTourGenerator.test.ts`, move those cases here and delete them there.

- [ ] **Step 4: Verify + commit.** Run `pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint`. All green (existing generation tests still pass — the Claude path is unchanged behaviorally). Then:

```bash
git add src/engine/server/src/generationPrompt.ts src/engine/server/src/claudeTourGenerator.ts src/engine/server/src/generationPrompt.test.ts src/engine/server/src/claudeTourGenerator.test.ts
git commit -m "refactor(engine-server): extract shared generation prompt + parseDraft"
```

---

## Task 2: Shared read-only tool layer `exploreTools.ts`

**Files:**

- Create: `src/engine/server/src/exploreTools.ts`
- Create: `src/engine/server/src/exploreTools.test.ts`
- Add dependency: `tinyglobby` to `src/engine/server/package.json`

**Context:** The Claude SDK gives the agent built-in `Read`/`Grep`/`Glob`; an OpenAI endpoint has none, so we implement them in-process, path-guarded, plus expose the Chunk 4b codemap tools. Each handler returns plain text.

- [ ] **Step 1: Add the glob dependency.** In `src/engine/server/package.json` dependencies add `"tinyglobby": "^0.2.0"`, run `pnpm install`. (tinyglobby is a tiny, dependency-light glob.)

- [ ] **Step 2: Failing test `exploreTools.test.ts`:**

```ts
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  runReadFileTool,
  runGrepTool,
  runGlobTool,
  EXPLORE_TOOL_DEFS,
  dispatchExploreTool,
} from "./exploreTools.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "explore-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("read_file returns numbered lines and guards traversal", async () => {
  await writeFile(path.join(root, "a.ts"), "alpha\nbeta\n");
  const out = await runReadFileTool(root, "a.ts");
  expect(out).toContain("alpha");
  expect((await runReadFileTool(root, "../escape.ts")).toLowerCase()).toContain(
    "outside the workspace",
  );
  expect((await runReadFileTool(root, "/etc/passwd")).toLowerCase()).toContain(
    "outside the workspace",
  );
});

test("grep finds matching lines with file:line prefixes", async () => {
  await writeFile(path.join(root, "a.ts"), "needle here\nother\n");
  await writeFile(path.join(root, "b.ts"), "nothing\n");
  const out = await runGrepTool(root, "needle");
  expect(out).toContain("a.ts");
  expect(out).toContain("needle here");
  expect(out).not.toContain("b.ts:");
});

test("glob lists matching files relative to root", async () => {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "x.ts"), "");
  await writeFile(path.join(root, "y.md"), "");
  const out = await runGlobTool(root, "**/*.ts");
  expect(out).toContain("src/x.ts");
  expect(out).not.toContain("y.md");
});

test("EXPLORE_TOOL_DEFS lists the five tools and dispatch routes by name", async () => {
  expect(EXPLORE_TOOL_DEFS.map((t) => t.function.name).sort()).toEqual(
    ["findSymbol", "fileOutline", "glob", "grep", "read_file"].sort(),
  );
  await writeFile(path.join(root, "a.ts"), "export function foo() {}\n");
  const text = await dispatchExploreTool(root, "findSymbol", {
    file: "a.ts",
    name: "foo",
  });
  expect(text).toContain("foo");
});
```

Run `pnpm --filter @made-i-t/hdtw-engine-server test` — expect FAIL.

- [ ] **Step 3: Implement `exploreTools.ts`:**

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { runFileOutlineTool, runFindSymbolTool } from "./codemapTools.js";

/** Resolve a workspace-relative path, rejecting absolute paths and traversal. */
function safeResolve(workspaceRoot: string, file: string): string | undefined {
  if (path.isAbsolute(file)) return undefined;
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, ...file.split("/"));
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    return undefined;
  return resolved;
}

const MAX_READ_BYTES = 64_000;
const MAX_GREP_MATCHES = 100;
const MAX_GLOB_RESULTS = 200;

export async function runReadFileTool(
  workspaceRoot: string,
  file: string,
): Promise<string> {
  const resolved = safeResolve(workspaceRoot, file);
  if (!resolved) return `Error: ${file} is outside the workspace.`;
  try {
    const content = (await readFile(resolved, "utf8")).slice(0, MAX_READ_BYTES);
    return content.split(/\r?\n/)
                  .map((line, i) => `${i + 1}\t${line}`)
                  .join("\n");
  } catch {
    return `Error: could not read ${file} (not found or unreadable).`;
  }
}

export async function runGrepTool(
  workspaceRoot: string,
  pattern: string,
  file?: string,
): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return `Error: invalid regex "${pattern}".`;
  }
  const files = file
    ? [file]
    : (
        await glob(["**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,json,md}"], {
          cwd: path.resolve(workspaceRoot),
          ignore: ["**/node_modules/**", "**/dist/**"],
        })
      ).slice(0, 2000);
  const hits: string[] = [];
  for (const rel of files) {
    const resolved = safeResolve(workspaceRoot, rel);
    if (!resolved) continue;
    let content: string;
    try {
      content = await readFile(resolved, "utf8");
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, i) => {
      if (hits.length < MAX_GREP_MATCHES && regex.test(line)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
    if (hits.length >= MAX_GREP_MATCHES) break;
  }
  return hits.length ? hits.join("\n") : `No matches for "${pattern}".`;
}

export async function runGlobTool(
  workspaceRoot: string,
  pattern: string,
): Promise<string> {
  const matches = (
    await glob([pattern], {
      cwd: path.resolve(workspaceRoot),
      ignore: ["**/node_modules/**", "**/dist/**"],
    })
  ).slice(0, MAX_GLOB_RESULTS);
  return matches.length ? matches.join("\n") : `No files match "${pattern}".`;
}

/** OpenAI function-tool schemas for every read-only exploration tool. */
export const EXPLORE_TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file in the workspace. Returns tab-separated `lineNumber\\tcontent`.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "Workspace-relative path, POSIX separators.",
          },
        },
        required: ["file"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description:
        "Search workspace files for a JS regex. Returns up to 100 `file:line: text` matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "JavaScript regular expression.",
          },
          file: {
            type: "string",
            description: "Optional: limit to one workspace-relative file.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "glob",
      description: "List workspace files matching a glob (e.g. src/**/*.ts).",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fileOutline",
      description:
        "List the named symbols (functions, classes, methods, consts) in a TS/JS file with line ranges.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" } },
        required: ["file"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "findSymbol",
      description:
        "Find a symbol by name (or Class.method) in a TS/JS file and get its current line range to anchor to.",
      parameters: {
        type: "object",
        properties: { file: { type: "string" }, name: { type: "string" } },
        required: ["file", "name"],
      },
    },
  },
];

/** Route a tool call (by name) to its handler. Unknown names return an error string. */
export async function dispatchExploreTool(
  workspaceRoot: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const file = typeof args.file === "string" ? args.file : "";
  switch (name) {
    case "read_file":
      return runReadFileTool(workspaceRoot, file);
    case "grep":
      return runGrepTool(
        workspaceRoot,
        String(args.pattern ?? ""),
        typeof args.file === "string" ? args.file : undefined,
      );
    case "glob":
      return runGlobTool(workspaceRoot, String(args.pattern ?? ""));
    case "fileOutline":
      return runFileOutlineTool(workspaceRoot, file);
    case "findSymbol":
      return runFindSymbolTool(workspaceRoot, file, String(args.name ?? ""));
    default:
      return `Error: unknown tool "${name}".`;
  }
}
```

- [ ] **Step 4: Green, build, lint, commit.**

```
pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint
```

```bash
git add src/engine/server/src/exploreTools.ts src/engine/server/src/exploreTools.test.ts src/engine/server/package.json pnpm-lock.yaml
git commit -m "feat(engine-server): provider-agnostic read-only explore tools (read_file/grep/glob + codemap)"
```

---

## Task 3: `OpenAiAgentTourGenerator` (injected client + explore loop)

**Files:**

- Create: `src/engine/server/src/openaiTourGenerator.ts`
- Create: `src/engine/server/src/openaiTourGenerator.test.ts`
- Add dependency: `openai` to `src/engine/server/package.json`

- [ ] **Step 1: Add the dependency.** Add `"openai": "^4.67.0"` to `src/engine/server/package.json` dependencies; `pnpm install`.

- [ ] **Step 2: Failing test `openaiTourGenerator.test.ts`** (drives the loop with a scripted mock client — no network):

````ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  OpenAiAgentTourGenerator,
  type ChatClient,
} from "./openaiTourGenerator.js";
import { createObserver } from "@made-i-t/hdtw-observability";
import { AuthRequiredError } from "./tourGenerator.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openai-"));
  await writeFile(
    path.join(root, "sample.ts"),
    "export function sample() {\n  return 1;\n}\n",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const observer = createObserver({ sink: { write() {} }, minLevel: "info" });
const hooks = () => ({
  onProgress: vi.fn(),
  signal: new AbortController().signal,
  observer,
});

const finalTour =
  "```json\n"
  + JSON.stringify({
    title: "Sample",
    summary: "s",
    steps: [
      {
        title: "a",
        narration: "n",
        anchor: { file: "sample.ts", symbol: "sample" },
      },
    ],
  })
  + "\n```";

test("runs a tool call then returns the parsed draft", async () => {
  const create = vi
    .fn()
    .mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "findSymbol",
                  arguments: JSON.stringify({
                    file: "sample.ts",
                    name: "sample",
                  }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    .mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: finalTour } }],
      usage: { prompt_tokens: 8, completion_tokens: 20 },
    });
  const client: ChatClient = { chat: { completions: { create } } };
  const gen = new OpenAiAgentTourGenerator(() => client, {});
  const draft = await gen.generate(
    root,
    "the sample fn",
    "gpt-test",
    [],
    hooks(),
  );
  expect(draft.steps[0].anchor).toMatchObject({
    file: "sample.ts",
    symbol: "sample",
  });
  // turn 1 issued the tool call; the tool result + assistant message were appended for turn 2
  expect(create).toHaveBeenCalledTimes(2);
  const secondCallMessages = create.mock.calls[1][0].messages;
  expect(
    secondCallMessages.some((m: { role: string }) => m.role === "tool"),
  ).toBe(true);
});

test("maps a 401 to AuthRequiredError", async () => {
  const create = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
  const client: ChatClient = { chat: { completions: { create } } };
  const gen = new OpenAiAgentTourGenerator(() => client, {});
  await expect(
    gen.generate(root, "x", "gpt-test", [], hooks()),
  ).rejects.toBeInstanceOf(AuthRequiredError);
});

test("gives up with a GenerationFailedError after maxTurns of tool calls", async () => {
  const create = vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "c",
              type: "function",
              function: {
                name: "glob",
                arguments: JSON.stringify({ pattern: "**/*" }),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const client: ChatClient = { chat: { completions: { create } } };
  const gen = new OpenAiAgentTourGenerator(() => client, { maxTurns: 3 });
  await expect(
    gen.generate(root, "x", "gpt-test", [], hooks()),
  ).rejects.toThrow(/within/);
  expect(create).toHaveBeenCalledTimes(3);
});
````

Run `pnpm --filter @made-i-t/hdtw-engine-server test` — expect FAIL.

- [ ] **Step 3: Implement `openaiTourGenerator.ts`:**

```ts
import {
  AuthRequiredError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
  type GenerationHooks,
  type TourGenerator,
} from "./tourGenerator.js";
import type { TourSummary } from "@made-i-t/hdtw-protocol";
import {
  SYSTEM_PROMPT,
  generatePrompt,
  repairPrompt,
  parseDraft,
} from "./generationPrompt.js";
import { EXPLORE_TOOL_DEFS, dispatchExploreTool } from "./exploreTools.js";

/** The slice of the OpenAI client we depend on (keeps tests + types narrow). */
export interface ChatClient {
  chat: {
    completions: {
      create(
        body: {
          model: string;
          messages: ChatMessage[];
          tools: typeof EXPLORE_TOOL_DEFS;
          tool_choice: "auto";
        },
        options?: { signal?: AbortSignal },
      ): Promise<ChatResponse>;
    };
  };
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ChatResponse {
  choices: {
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiGeneratorOptions {
  maxTurns?: number;
  usdPer1kInput?: number;
  usdPer1kOutput?: number;
}

const DEFAULT_MAX_TURNS = 40;

export class OpenAiAgentTourGenerator implements TourGenerator {
  constructor(
    private readonly clientFactory: () => ChatClient,
    private readonly options: OpenAiGeneratorOptions,
  ) {}

  generate(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    catalog: TourSummary[],
    hooks: GenerationHooks,
  ): Promise<DraftTour> {
    return this.runLoop(
      workspaceRoot,
      model,
      generatePrompt(topic, catalog),
      "exploring",
      hooks,
    );
  }

  repair(
    workspaceRoot: string,
    topic: string,
    model: string | undefined,
    _catalog: TourSummary[],
    draft: DraftTour,
    anchorErrors: string[],
    hooks: GenerationHooks,
  ): Promise<DraftTour> {
    return this.runLoop(
      workspaceRoot,
      model,
      repairPrompt(topic, draft, anchorErrors),
      "repairing",
      hooks,
    );
  }

  private async runLoop(
    workspaceRoot: string,
    model: string | undefined,
    userPrompt: string,
    phase: "exploring" | "repairing",
    hooks: GenerationHooks,
  ): Promise<DraftTour> {
    const client = this.clientFactory();
    const maxTurns = this.options.maxTurns ?? DEFAULT_MAX_TURNS;
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ];
    let tokensIn = 0;
    let tokensOut = 0;

    for (let turn = 0; turn < maxTurns; turn += 1) {
      if (hooks.signal.aborted)
        throw new GenerationCancelledError("generation aborted");
      let res: ChatResponse;
      try {
        res = await client.chat.completions.create(
          {
            model: model ?? "gpt-4o",
            messages,
            tools: EXPLORE_TOOL_DEFS,
            tool_choice: "auto",
          },
          { signal: hooks.signal },
        );
      } catch (error) {
        if (hooks.signal.aborted)
          throw new GenerationCancelledError("generation aborted");
        if (isAuthError(error)) {
          throw new AuthRequiredError(
            "No credentials for the configured model provider. Set an API key (HDTW: Set API Key).",
          );
        }
        throw new GenerationFailedError(
          error instanceof Error ? error.message : String(error),
        );
      }

      tokensIn += res.usage?.prompt_tokens ?? 0;
      tokensOut += res.usage?.completion_tokens ?? 0;
      hooks.onProgress({
        phase,
        message:
          phase === "exploring"
            ? "Model exploring the codebase"
            : "Model repairing anchors",
        tokensIn,
        tokensOut,
        estimatedCostUsd:
          (tokensIn / 1000) * (this.options.usdPer1kInput ?? 0)
          + (tokensOut / 1000) * (this.options.usdPer1kOutput ?? 0),
      });

      const message = res.choices[0]?.message;
      if (message?.tool_calls?.length) {
        messages.push({
          role: "assistant",
          content: message.content ?? null,
          tool_calls: message.tool_calls,
        });
        for (const call of message.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments) as Record<
              string,
              unknown
            >;
          } catch {
            args = {};
          }
          const text = await dispatchExploreTool(
            workspaceRoot,
            call.function.name,
            args,
          );
          hooks.observer.logger.debug("agent.tool", {
            tool: call.function.name,
            args,
          });
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
        }
        continue;
      }

      return parseDraft(message?.content ?? "");
    }
    throw new GenerationFailedError(
      `model did not produce a tour within ${maxTurns} turns`,
    );
  }
}

function isAuthError(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 401 || status === 403) return true;
  const text = error instanceof Error ? error.message : String(error);
  return /api key|authentication|unauthorized|401|403|credential/i.test(text);
}
```

- [ ] **Step 4: Green, build, lint, commit.**

```
pnpm --filter @made-i-t/hdtw-engine-server test && pnpm --filter @made-i-t/hdtw-engine-server build && pnpm --filter @made-i-t/hdtw-engine-server lint
```

```bash
git add src/engine/server/src/openaiTourGenerator.ts src/engine/server/src/openaiTourGenerator.test.ts src/engine/server/package.json pnpm-lock.yaml
git commit -m "feat(engine-server): OpenAiAgentTourGenerator with injected client + explore loop"
```

---

## Task 4: Protocol — `provider`/`baseUrl`/pricing on `GenerateTourParams`

**Files:**

- Modify: `src/protocol/src/generation.ts` (the `GenerateTourParams` interface)
- Test: the protocol generation test file

- [ ] **Step 1: Read `src/protocol/src/generation.ts`** and find `GenerateTourParams` (currently has `workspaceRoot`, `topic`, `save?`, `model?`, `maxBudgetUsd?`). Add additive optional fields:

```ts
  /** Generation backend. Defaults to "anthropic" (the Claude Agent SDK). */
  provider?: "anthropic" | "openai";
  /** OpenAI-compatible base URL (only when provider is "openai"). */
  baseUrl?: string;
  /** Optional budget pricing for non-Anthropic providers (per 1k tokens). */
  usdPer1kInput?: number;
  usdPer1kOutput?: number;
```

- [ ] **Step 2: Add a type test** (append to the protocol generation test file):

```ts
import type { GenerateTourParams } from "./generation.js";
test("GenerateTourParams accepts an openai provider + baseUrl additively", () => {
  const p: GenerateTourParams = {
    workspaceRoot: "/w",
    topic: "t",
    provider: "openai",
    baseUrl: "http://localhost:11434/v1",
  };
  expect(p.provider).toBe("openai");
  const claudeDefault: GenerateTourParams = { workspaceRoot: "/w", topic: "t" };
  expect(claudeDefault.provider).toBeUndefined();
});
```

- [ ] **Step 3: Build, test, commit.**

```
pnpm --filter @made-i-t/hdtw-protocol build && pnpm --filter @made-i-t/hdtw-protocol test
```

```bash
git add src/protocol/src/generation.ts src/protocol/src/*.test.ts
git commit -m "feat(protocol): provider/baseUrl/pricing on GenerateTourParams (BYOM)"
```

---

## Task 5: Provider-selection factory in the engine

**Files:**

- Modify: `src/engine/server/src/main.ts`
- Test: `src/engine/server/tests/generation.e2e.test.ts` (a fake-path assertion that an `openai` provider request is still routed/handled)

**Context:** `createGenerator()` currently ignores params. It must become param-aware so a request with `provider: "openai"` builds an `OpenAiAgentTourGenerator` configured from the params + `OPENAI_API_KEY` env. The fake generator still wins under `HDTW_GENERATOR=fake` so e2e stays deterministic.

- [ ] **Step 1: Make `createGenerator` take the params** and select by provider. In `main.ts`, replace the no-arg `createGenerator()` and its call site:

```ts
import OpenAI from "openai";
import { OpenAiAgentTourGenerator } from "./openaiTourGenerator.js";
// ...
function createGenerator(params: GenerateTourParams): TourGenerator {
  if (process.env.HDTW_GENERATOR === "fake") return new FakeTourGenerator();
  if (params.provider === "openai") {
    return new OpenAiAgentTourGenerator(
      () =>
        new OpenAI({
          apiKey: process.env.OPENAI_API_KEY ?? "ollama",
          baseURL: params.baseUrl,
        }) as unknown as import("./openaiTourGenerator.js").ChatClient,
      {
        usdPer1kInput: params.usdPer1kInput,
        usdPer1kOutput: params.usdPer1kOutput,
      },
    );
  }
  return new ClaudeAgentTourGenerator();
}
```

(The `apiKey: ... ?? "ollama"` lets keyless local endpoints work — the `openai` SDK requires a non-empty string.) Update the `GENERATE_TOUR_METHOD` handler to call `createGenerator(params)`.

- [ ] **Step 2: e2e sanity** — in `generation.e2e.test.ts`, add a test that with `HDTW_GENERATOR=fake` a request carrying `provider: "openai"` still returns the fake tour (proving the param threads through and the fake short-circuit wins). Mirror the existing harness.

- [ ] **Step 3: Build, test, lint, commit.**

```
pnpm --filter @made-i-t/hdtw-engine-server test && pnpm build && pnpm --filter @made-i-t/hdtw-engine-server lint
```

Root build 6/6.

```bash
git add src/engine/server/src/main.ts src/engine/server/tests/generation.e2e.test.ts
git commit -m "feat(engine-server): provider-selection factory routes openai vs anthropic"
```

---

## Task 6: VS Code — provider config, provider-aware key, engine spawn env

**Files:**

- Modify: `src/clients/vscode/package.json` (configuration contributions)
- Modify: `src/clients/vscode/src/extension.ts` (generate params, setApiKey, engine spawn env)
- Modify: `src/clients/vscode/src/engineClient.ts` (only if it constructs the spawn env — confirm where env is set)

- [ ] **Step 1: Read first.** Read how `extension.ts` reads `hdtw.generation` config and builds `generateTour` params; how `setApiKey` stores the Anthropic key; and where the engine subprocess is spawned and its `env` is built (the `ANTHROPIC_API_KEY` path — likely in `engineClient.ts` or `extension.ts`). Match these patterns.

- [ ] **Step 2: Manifest config.** In `src/clients/vscode/package.json` `contributes.configuration.properties`, add:

```json
      "hdtw.generation.provider": { "type": "string", "enum": ["anthropic", "openai"], "default": "anthropic", "description": "Tour generation backend. 'openai' uses any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, …)." },
      "hdtw.generation.baseUrl": { "type": "string", "default": "", "description": "OpenAI-compatible base URL when provider is 'openai' (e.g. https://api.openai.com/v1, http://localhost:11434/v1)." },
      "hdtw.generation.usdPer1kInput": { "type": "number", "default": 0, "description": "Optional input-token price (USD per 1k) for budget estimates with non-Anthropic providers." },
      "hdtw.generation.usdPer1kOutput": { "type": "number", "default": 0, "description": "Optional output-token price (USD per 1k)." }
```

(Keep the existing `hdtw.generation.model`/`maxBudgetUsd` entries.)

- [ ] **Step 3: Thread provider config into generate params.** Where `extension.ts` builds the `generateTour` params (the `askWalk`/`generateTour` command), read the config and include the new fields:

```ts
const config = vscode.workspace.getConfiguration("hdtw.generation");
const provider = config.get<string>("provider", "anthropic");
const baseUrl = config.get<string>("baseUrl", "");
const usdPer1kInput = config.get<number>("usdPer1kInput", 0);
const usdPer1kOutput = config.get<number>("usdPer1kOutput", 0);
// ...in the params object:
provider: provider === "openai" ? "openai" : undefined,
baseUrl: provider === "openai" && baseUrl ? baseUrl : undefined,
usdPer1kInput: provider === "openai" ? usdPer1kInput : undefined,
usdPer1kOutput: provider === "openai" ? usdPer1kOutput : undefined,
```

(Send `provider: undefined` for anthropic so the engine default path is unchanged.)

- [ ] **Step 4: Provider-aware key storage + spawn env.**
  - In `setApiKey`: read `hdtw.generation.provider`; store the key under a provider-specific SecretStorage key (`hdtw.openaiApiKey` for openai, the existing key for anthropic); the input box title/prompt should name the provider.
  - Where the engine is spawned, extend the `env` so that when an OpenAI key is stored it is passed as `OPENAI_API_KEY` (alongside the existing `ANTHROPIC_API_KEY`). Both can be present; the engine picks per request. Read both secrets at spawn and set whichever exist.

- [ ] **Step 5: Build, lint, test, commit.**

```
pnpm --filter hdtw-vscode build && pnpm --filter hdtw-vscode lint && pnpm --filter hdtw-vscode test && node -e "JSON.parse(require('fs').readFileSync('src/clients/vscode/package.json','utf8'))"
```

All green; manifest valid.

```bash
git add src/clients/vscode
git commit -m "feat(vscode): provider/baseUrl/pricing config, provider-aware API key + engine env"
```

---

## Task 7: Docs — roadmap + AGENTS

**Files:**

- Modify: `docs/product-roadmap.md`
- Modify: `AGENTS.md` (if it enumerates generation backends/methods)

- [ ] **Step 1:** Add a roadmap entry for "BYOM — OpenAI-compatible generation ✅ shipped 2026-06-15" with the spec link (`docs/superpowers/specs/2026-06-15-openai-byom-design.md`) and a feature table: second `TourGenerator` (OpenAI tool-calling loop), shared explore tool layer, provider/baseUrl/pricing config, works with OpenAI/OpenRouter/Ollama/Gemini-compat, Q&A BYOM + marketplace packaging still pending. Note the `TourGenerator` port paid off (verification backend-blind).

- [ ] **Step 2:** If `AGENTS.md` lists the generation backend or auth model, add the OpenAI provider + `OPENAI_API_KEY` + provider config. Skip if no such list exists.

- [ ] **Step 3: Commit.**

```bash
git add docs/product-roadmap.md AGENTS.md
git commit -m "docs: mark OpenAI BYOM (generation) shipped"
```

---

## Final verification (after all tasks)

```bash
pnpm build && pnpm test && pnpm lint
```

Expected: 6/6 build; full suite green (engine-server gains the explore-tools, openai-generator, and prompt-extraction tests; protocol +1); lint clean.

**Dogfood (manual, F5):** set `hdtw.generation.provider = "openai"`, `baseUrl = "http://localhost:11434/v1"` (Ollama) or OpenAI + key; run "Generate Tour…"; confirm a verified, walkable tour with ≥1 symbol-anchored step, live token progress, working cancel; flip back to `anthropic` and confirm the Claude path is unchanged. Then re-walk the dogfood tours before merge (this chunk edits engine-server files some tours anchor).
