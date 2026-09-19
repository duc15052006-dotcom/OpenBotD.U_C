import { describe, expect, test } from "bun:test";
import { parseMemoryHistory } from "@/lib/memory/history";

describe("memory history parsing", () => {
  test("keeps only fully valid user-scoped history rows", () => {
    const parsed = parseMemoryHistory({
      memories: [
        {
          id: "user-memory",
          kind: "operational",
          scope: "user",
          content: "Prefers concise status updates.",
          sourceThreadIds: ["thread-1"],
          invalidatedAt: "2026-09-19T00:00:00.000Z",
        },
        {
          id: "project-memory",
          kind: "topical",
          scope: "project",
          content: "Shared project fact that must not enter the user history UI.",
          sourceThreadIds: ["thread-2"],
          invalidatedAt: null,
        },
        {
          id: "bad-provenance",
          kind: "episodic",
          scope: "user",
          content: "Malformed provenance",
          sourceThreadIds: ["thread-3", 7],
          invalidatedAt: null,
        },
      ],
    });

    expect(parsed).toEqual([
      {
        id: "user-memory",
        kind: "operational",
        scope: "user",
        content: "Prefers concise status updates.",
        sourceThreadIds: ["thread-1"],
        invalidatedAt: "2026-09-19T00:00:00.000Z",
      },
    ]);
  });

  test("rejects an invalid history envelope", () => {
    expect(() => parseMemoryHistory(null)).toThrow(
      "Memory history returned an invalid response.",
    );
    expect(() => parseMemoryHistory({ memories: "not-an-array" })).toThrow(
      "Memory history returned an invalid response.",
    );
  });
});
