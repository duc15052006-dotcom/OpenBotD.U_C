import { describe, expect, test } from "bun:test";

import { computerMaxActive } from "./computer-max-active";

describe("computerMaxActive", () => {
  test("accepts a positive deployment ceiling", () => {
    expect(computerMaxActive("3")).toEqual({ ok: true, maxActive: 3 });
  });

  test("leaves an unset value to the deployment default", () => {
    expect(computerMaxActive(undefined)).toEqual({
      ok: true,
      maxActive: undefined,
    });
  });

  test("fails closed on zero, fractions, junk and unreasonable values", () => {
    for (const value of ["0", "-1", "2.5", "three", "129"]) {
      expect(computerMaxActive(value).ok).toBe(false);
    }
  });
});
