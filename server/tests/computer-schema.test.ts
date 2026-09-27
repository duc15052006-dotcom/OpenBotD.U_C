import { describe, expect, test } from "bun:test";

import {
  COMPUTER_ACTING_TOOLS,
  COMPUTER_TOOLS,
  isActingTool,
} from "../src/computer/schema";

describe("computer tool contract", () => {
  test("raw command execution is always classified as an acting tool", () => {
    expect(COMPUTER_TOOLS).toContain("computer_run_command");
    expect(COMPUTER_ACTING_TOOLS).toContain("computer_run_command");
    expect(isActingTool("computer_run_command")).toBe(true);
  });
});
