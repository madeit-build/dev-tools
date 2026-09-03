import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { getTour, listTours, TourNotFoundError } from "../src/tourHandlers.js";

const workspaceRoot = fileURLToPath(new URL("./fixtures/workspace", import.meta.url));

describe("listTours", () => {
  test("lists valid and invalid tours, sorted by filename", async () => {
    const result = await listTours({ workspaceRoot });
    expect(result.tours).toHaveLength(2);
    const [broken, good] = result.tours;
    expect(broken.id).toBe("broken-tour");
    expect(broken.error).toContain("schemaVersion must be 1");
    expect(good).toEqual({
      id: "good-tour",
      title: "Good tour",
      summary: "A valid fixture tour",
      stepCount: 1,
    });
  });

  test("returns empty list when .hdtw/tours is absent", async () => {
    const result = await listTours({ workspaceRoot: "/nonexistent/path" });
    expect(result.tours).toEqual([]);
  });

  test("degrades unreadable files to error summaries instead of rejecting", async () => {
    const { mkdir, rmdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const fakeDir = path.join(workspaceRoot, ".hdtw", "tours", "dir-tour.tour.json");
    await mkdir(fakeDir);
    try {
      const result = await listTours({ workspaceRoot });
      const dirTour = result.tours.find((tour) => tour.id === "dir-tour");
      expect(dirTour?.error).toContain("could not read file");
      expect(result.tours.map((tour) => tour.id)).toContain("good-tour");
    } finally {
      await rmdir(fakeDir);
    }
  });
});

describe("getTour", () => {
  test("returns a valid tour", async () => {
    const result = await getTour({ workspaceRoot, tourId: "good-tour" });
    expect(result.tour.title).toBe("Good tour");
    expect(result.tour.steps[0].anchor.file).toBe("README.md");
  });

  test("throws TourNotFoundError for unknown id", async () => {
    await expect(getTour({ workspaceRoot, tourId: "nope" })).rejects.toBeInstanceOf(
      TourNotFoundError
    );
  });

  test("throws TourNotFoundError for an invalid tour", async () => {
    await expect(getTour({ workspaceRoot, tourId: "broken-tour" })).rejects.toBeInstanceOf(
      TourNotFoundError
    );
  });

  test("rejects path-traversal ids", async () => {
    await expect(
      getTour({ workspaceRoot, tourId: "../../../etc/passwd" })
    ).rejects.toBeInstanceOf(TourNotFoundError);
  });
});
