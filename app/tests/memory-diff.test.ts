import { describe, expect, test } from "bun:test";
import { diffMemoryLines } from "../src/lib/memory/diff";

describe("memory diff", () => {
  test("keeps common prefix and suffix and marks only changed middle", () => {
    expect(diffMemoryLines("same\nold\ntail", "same\nnew\ntail")).toEqual([
      { type: "same", text: "same" },
      { type: "removed", text: "old" },
      { type: "added", text: "new" },
      { type: "same", text: "tail" },
    ]);
  });

  test("handles empty and multiline values without quadratic matching", () => {
    expect(diffMemoryLines("", "one\ntwo")).toEqual([
      { type: "removed", text: "" },
      { type: "added", text: "one" },
      { type: "added", text: "two" },
    ]);
  });
});
