import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GenerationProgressParams } from "@made-i-t/hdtw-protocol";
import { FakeTourGenerator } from "../src/fakeTourGenerator.js";
import { runGeneration } from "../src/generationPipeline.js";
import {
  BudgetExceededError,
  GenerationCancelledError,
  GenerationFailedError,
  type DraftTour,
} from "../src/tourGenerator.js";

let workspaceRoot: string;
let progress: GenerationProgressParams[];

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "hdtw-gen-"));
  await writeFile(path.join(workspaceRoot, "README.md"), "fixture readme\nsecond line\n");
  progress = [];
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function run(generator: FakeTourGenerator, options: { maxBudgetUsd?: number; signal?: AbortSignal } = {}) {
  const controller = new AbortController();
  return runGeneration(
    { workspaceRoot, topic: "how does it work", maxBudgetUsd: options.maxBudgetUsd },
    generator,
    (p) => progress.push(p),
    options.signal ?? controller.signal
  );
}

const BAD_DRAFT: DraftTour = {
  title: "Fake tour",
  summary: "Bad anchors",
  steps: [
    {
      title: "Nope",
      narration: "Points past EOF.",
      anchor: { file: "README.md", startLine: 1, endLine: 99 },
    },
  ],
};

describe("runGeneration", () => {
  test("happy path: verifies, saves atomically, returns tour + relative path", async () => {
    const result = await run(new FakeTourGenerator());
    expect(result.savedPath).toBe(".hdtw/tours/fake-tour.tour.json");
    expect(result.tour.id).toBe("fake-tour");
    expect(result.tour.steps[0].anchor.snippetHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const onDisk = await readFile(path.join(workspaceRoot, result.savedPath), "utf8");
    expect(JSON.parse(onDisk).id).toBe("fake-tour");
    expect(progress.some((p) => p.phase === "verifying")).toBe(true);
    expect(progress.some((p) => p.phase === "saving")).toBe(true);
  });

  test("repair round: bad draft is repaired then saved", async () => {
    const generator = new FakeTourGenerator({ draft: BAD_DRAFT });
    const result = await run(generator);
    expect(result.tour.steps[0].anchor.endLine).toBe(1);
    expect(progress.some((p) => p.phase === "repairing")).toBe(true);
  });

  test("fails after one repair round if anchors still bad", async () => {
    const generator = new FakeTourGenerator({ draft: BAD_DRAFT, repairedDraft: BAD_DRAFT });
    await expect(run(generator)).rejects.toBeInstanceOf(GenerationFailedError);
    const files = await readFile(path.join(workspaceRoot, ".hdtw/tours/fake-tour.tour.json"), "utf8").catch(() => undefined);
    expect(files).toBeUndefined(); // nothing written on failure
  });

  test("budget: aborts when estimated cost crosses maxBudgetUsd", async () => {
    const generator = new FakeTourGenerator({ costPerEvent: 5 });
    await expect(run(generator, { maxBudgetUsd: 1 })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("budget: aborts when CUMULATIVE cost crosses budget even if no single event does", async () => {
    // exploring + drafting each add 0.8 → cumulative 1.6 > 1.5 on the second event
    const generator = new FakeTourGenerator({ costPerEvent: 0.8 });
    await expect(run(generator, { maxBudgetUsd: 1.5 })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  test("cancellation: pre-aborted signal cancels cleanly", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(new FakeTourGenerator(), { signal: controller.signal })).rejects.toBeInstanceOf(
      GenerationCancelledError
    );
  });

  test("filename collision gets a numeric suffix", async () => {
    await mkdir(path.join(workspaceRoot, ".hdtw", "tours"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".hdtw/tours/fake-tour.tour.json"), "{}");
    const result = await run(new FakeTourGenerator());
    expect(result.savedPath).toBe(".hdtw/tours/fake-tour-2.tour.json");
    expect(result.tour.id).toBe("fake-tour-2");
  });

  test("rejects an anchor path that escapes the workspace", async () => {
    const escaping: DraftTour = {
      title: "Fake tour",
      summary: "Escapes",
      steps: [
        {
          title: "Escape",
          narration: "Tries to read outside the workspace.",
          anchor: { file: "../escape.txt", startLine: 1, endLine: 1 },
        },
      ],
    };
    const generator = new FakeTourGenerator({ draft: escaping, repairedDraft: escaping });
    await expect(run(generator)).rejects.toBeInstanceOf(GenerationFailedError);
  });
});
