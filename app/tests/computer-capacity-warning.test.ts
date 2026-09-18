import { describe, expect, test } from "bun:test";
import { computerStartWarning } from "../src/routes/_authed/admin/computers";

function fleet(
  running: number,
  overrides: Partial<{
    memoryBytes: number | null;
    logicalCpus: number | null;
    maxActiveComputers: number | null;
    defaultComputerMemoryBytes: number | null;
    defaultComputerNanoCpus: number | null;
  }> = {},
) {
  return {
    computers: Array.from({ length: running }, () => ({
      running: true,
      metrics: { memoryLimitBytes: 2 * 1024 ** 3 },
    })),
    capacity: {
      memoryBytes: 16 * 1024 ** 3,
      logicalCpus: 12,
      maxActiveComputers: 3,
      defaultComputerMemoryBytes: 2 * 1024 ** 3,
      defaultComputerNanoCpus: 2_000_000_000,
      ...overrides,
    },
  };
}

describe("Computer start resource warning", () => {
  test("warns before consuming the final active Computer slot", () => {
    expect(computerStartWarning(fleet(2))).toContain("3 of 3");
  });

  test("warns when projected memory quota crosses 80% of engine RAM", () => {
    expect(
      computerStartWarning(
        fleet(2, {
          maxActiveComputers: 10,
          memoryBytes: 6 * 1024 ** 3,
          logicalCpus: 64,
        }),
      ),
    ).toContain("100%");
  });

  test("warns when projected CPU quota crosses 80% of engine capacity", () => {
    expect(
      computerStartWarning(
        fleet(2, {
          maxActiveComputers: 10,
          memoryBytes: 64 * 1024 ** 3,
          logicalCpus: 6,
        }),
      ),
    ).toContain("100%");
  });

  test("does not warn when the next Computer fits comfortably", () => {
    expect(
      computerStartWarning(
        fleet(1, {
          maxActiveComputers: 6,
          memoryBytes: 16 * 1024 ** 3,
          logicalCpus: 12,
        }),
      ),
    ).toBeNull();
  });
});
