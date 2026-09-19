import { describe, expect, test } from "bun:test";

import { computerNanoCpus } from "./computer-nano-cpus";

describe("computerNanoCpus", () => {
  test("treats an unset value as no explicit override", () => {
    expect(computerNanoCpus(undefined)).toEqual({
      ok: true,
      nanoCpus: undefined,
    });
    expect(computerNanoCpus("   ")).toEqual({ ok: true, nanoCpus: undefined });
  });

  test("accepts an exact positive integer", () => {
    expect(computerNanoCpus("2000000000")).toEqual({
      ok: true,
      nanoCpus: 2_000_000_000,
    });
  });

  test("fails closed on malformed or unsafe values", () => {
    for (const value of ["0", "-1", "2.5", "2cpu", "9007199254740992"]) {
      expect(computerNanoCpus(value).ok).toBe(false);
    }
  });
});
