import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runOpenAiToolLoop, type ChatClient } from "./openaiToolLoop.js";
import { createObserver } from "@made-i-t/hdtw-observability";
import { AuthRequiredError, GenerationFailedError } from "./tourGenerator.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openai-tool-loop-"));
  await writeFile(
    path.join(root, "sample.ts"),
    "export function sample() {\n  return 1;\n}\n",
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const observer = createObserver({ sink: { record() {} }, minLevel: "info" });
const hooks = () => ({
  onProgress: vi.fn(),
  signal: new AbortController().signal,
  observer,
});

const finalText = "Hello from model";

test("returns the final assistant text string", async () => {
  const create = vi.fn().mockResolvedValueOnce({
    choices: [{ message: { role: "assistant", content: finalText } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const client: ChatClient = { chat: { completions: { create } } };
  const result = await runOpenAiToolLoop(
    client,
    "gpt-test",
    "sys",
    "user",
    {
      maxTurns: 5,
      phase: "exploring",
      progressMessage: "x",
      workspaceRoot: root,
    },
    hooks(),
  );
  expect(result).toBe(finalText);
});

test("maps a 401 to AuthRequiredError", async () => {
  const create = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );
  const client: ChatClient = { chat: { completions: { create } } };
  await expect(
    runOpenAiToolLoop(
      client,
      "gpt-test",
      "sys",
      "user",
      {
        maxTurns: 5,
        phase: "exploring",
        progressMessage: "x",
        workspaceRoot: root,
      },
      hooks(),
    ),
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
  await expect(
    runOpenAiToolLoop(
      client,
      "gpt-test",
      "sys",
      "user",
      {
        maxTurns: 3,
        phase: "exploring",
        progressMessage: "x",
        workspaceRoot: root,
      },
      hooks(),
    ),
  ).rejects.toBeInstanceOf(GenerationFailedError);
  expect(create).toHaveBeenCalledTimes(3);
});
