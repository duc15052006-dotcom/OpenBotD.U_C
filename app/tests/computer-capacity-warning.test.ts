import { describe, expect, test } from "bun:test";
import { computerStartWarning } from "../src/routes/_authed/admin/computers";

const quotas = {
  light: { memoryBytes: 1.5 * 1024 ** 3, nanoCpus: 1_000_000_000 },
  normal: { memoryBytes: 2 * 1024 ** 3, nanoCpus: 2_000_000_000 },
  heavy: { memoryBytes: 4 * 1024 ** 3, nanoCpus: 3_000_000_000 },
};

function fleet(runningIds: string[], overrides: Partial<{memoryBytes:number|null;logicalCpus:number|null;maxActiveComputers:number|null}> = {}) {
  return { computers: runningIds.map((botId) => ({ botId, running: true })), capacity: { memoryBytes: 16 * 1024 ** 3, logicalCpus: 12, maxActiveComputers: 3, resourceProfiles: quotas, ...overrides } };
}

describe("Computer start resource warning", () => {
  test("warns before consuming the final active Computer slot", () => {
    expect(computerStartWarning(fleet(["a","b"]), "c", { a:"normal", b:"normal", c:"light" })).toContain("3 of 3");
  });
  test("uses target and running profiles for projected memory", () => {
    expect(computerStartWarning(fleet(["a"], { maxActiveComputers:10, memoryBytes:6*1024**3, logicalCpus:64 }), "b", { a:"normal", b:"heavy" })).toContain("100%");
  });
  test("uses per-Agent CPU quotas", () => {
    expect(computerStartWarning(fleet(["a"], { maxActiveComputers:10, memoryBytes:64*1024**3, logicalCpus:5 }), "b", { a:"heavy", b:"light" })).toContain("80%");
  });
  test("does not warn when comfortably below capacity", () => {
    expect(computerStartWarning(fleet(["a"], { maxActiveComputers:6, memoryBytes:16*1024**3, logicalCpus:12 }), "b", { a:"light", b:"light" })).toBeNull();
  });
});
