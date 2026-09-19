import { describe, expect, test } from "bun:test";

import {
  computerResourceProfile,
  DEFAULT_COMPUTER_RESOURCE_PROFILE,
} from "../src/computer/resource-profile";

describe("computer resource profiles", () => {
  test("keeps Normal as the compatibility default", () => {
    expect(DEFAULT_COMPUTER_RESOURCE_PROFILE).toBe("normal");
  });

  test("accepts only the three bounded profile names", () => {
    expect(computerResourceProfile("light")).toBe("light");
    expect(computerResourceProfile("normal")).toBe("normal");
    expect(computerResourceProfile("heavy")).toBe("heavy");
    for (const value of ["unlimited", "custom", "", 4, null]) {
      expect(computerResourceProfile(value)).toBeNull();
    }
  });
});
