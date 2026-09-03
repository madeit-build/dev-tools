import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OpenAiStepAnswerer } from "./openaiStepAnswerer.js";
import type { ChatClient } from "./openaiToolLoop.js";
import { createObserver } from "@made-i-t/hdtw-observability";
import { GenerationFailedError } from "./tourGenerator.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "qa-"));
  await writeFile(path.join(root, "a.ts"), "export function foo() { return 1; }\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const observer = createObserver({ sink: { record() {} }, minLevel: "info" });
const hooks = () => ({ onProgress: vi.fn(), signal: new AbortController().signal, observer });
const ctx = { file: "a.ts", startLine: 1, endLine: 1, narration: "n", tourTitle: "T" };

test("returns the model's prose as the answer", async () => {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { role: "assistant", content: "Because it keeps the engine pure." } }],
    usage: { prompt_tokens: 5, completion_tokens: 8 },
  });
  const client: ChatClient = { chat: { completions: { create } } };
  const answerer = new OpenAiStepAnswerer(() => client, {});
  const answer = await answerer.answer(root, ctx, "why?", "gpt-test", hooks());
  expect(answer).toBe("Because it keeps the engine pure.");
});

test("an empty answer throws GenerationFailedError", async () => {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { role: "assistant", content: "   " } }], usage: {} });
  const client: ChatClient = { chat: { completions: { create } } };
  const answerer = new OpenAiStepAnswerer(() => client, {});
  await expect(answerer.answer(root, ctx, "why?", "gpt-test", hooks())).rejects.toBeInstanceOf(GenerationFailedError);
});
