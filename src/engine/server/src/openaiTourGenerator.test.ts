import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { OpenAiAgentTourGenerator, type ChatClient } from "./openaiTourGenerator.js";
import { createObserver } from "@made-i-t/hdtw-observability";
import { AuthRequiredError } from "./tourGenerator.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openai-"));
  await writeFile(path.join(root, "sample.ts"), "export function sample() {\n  return 1;\n}\n");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// ObservabilitySink interface uses record(), not write()
const observer = createObserver({ sink: { record() {} }, minLevel: "info" });
const hooks = () => ({ onProgress: vi.fn(), signal: new AbortController().signal, observer });

const finalTour = "```json\n" + JSON.stringify({
  title: "Sample", summary: "s",
  steps: [{ title: "a", narration: "n", anchor: { file: "sample.ts", symbol: "sample" } }],
}) + "\n```";

test("runs a tool call then returns the parsed draft", async () => {
  const create = vi.fn()
    .mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "c1", type: "function", function: { name: "findSymbol", arguments: JSON.stringify({ file: "sample.ts", name: "sample" }) } },
      ] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    .mockResolvedValueOnce({
      choices: [{ message: { role: "assistant", content: finalTour } }],
      usage: { prompt_tokens: 8, completion_tokens: 20 },
    });
  const client: ChatClient = { chat: { completions: { create } } };
  const gen = new OpenAiAgentTourGenerator(() => client, {});
  const draft = await gen.generate(root, "the sample fn", "gpt-test", [], hooks());
  expect(draft.steps[0].anchor).toMatchObject({ file: "sample.ts", symbol: "sample" });
  expect(create).toHaveBeenCalledTimes(2);
  const secondCallMessages = create.mock.calls[1][0].messages;
  expect(secondCallMessages.some((m: { role: string }) => m.role === "tool")).toBe(true);
});

test("maps a 401 to AuthRequiredError", async () => {
  const create = vi.fn().mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
  const client: ChatClient = { chat: { completions: { create } } };
  const gen = new OpenAiAgentTourGenerator(() => client, {});
  await expect(gen.generate(root, "x", "gpt-test", [], hooks())).rejects.toBeInstanceOf(AuthRequiredError);
});

test("gives up with a GenerationFailedError after maxTurns of tool calls", async () => {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { role: "assistant", content: null, tool_calls: [
      { id: "c", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "**/*" }) } },
    ] } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
  const client: ChatClient = { chat: { completions: { create } } };
  const gen = new OpenAiAgentTourGenerator(() => client, { maxTurns: 3 });
  await expect(gen.generate(root, "x", "gpt-test", [], hooks())).rejects.toThrow(/within/);
  expect(create).toHaveBeenCalledTimes(3);
});
