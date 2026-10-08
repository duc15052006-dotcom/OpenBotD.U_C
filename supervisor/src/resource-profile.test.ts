import { describe, expect, test } from "bun:test";

import {
  parseComputerResourceProfile,
  RESOURCE_PROFILES,
} from "./resource-profile";

describe("resource profile quotas", () => {
  test("maps Light Normal and Heavy to bounded CPU and RAM", () => {
    expect(RESOURCE_PROFILES.light).toEqual({
      memoryBytes: 1_610_612_736,
      nanoCpus: 1_000_000_000,
    });
    expect(RESOURCE_PROFILES.normal).toEqual({
      memoryBytes: 2_147_483_648,
      nanoCpus: 2_000_000_000,
    });
    expect(RESOURCE_PROFILES.heavy).toEqual({
      memoryBytes: 4_294_967_296,
      nanoCpus: 3_000_000_000,
    });
  });

  test("does not accept arbitrary quota names", () => {
    expect(parseComputerResourceProfile("light")).toBe("light");
    expect(parseComputerResourceProfile("normal")).toBe("normal");
    expect(parseComputerResourceProfile("heavy")).toBe("heavy");
    expect(parseComputerResourceProfile("unlimited")).toBeNull();
    expect(
      parseComputerResourceProfile({ memoryBytes: 99_000_000_000 }),
    ).toBeNull();
  });
});
