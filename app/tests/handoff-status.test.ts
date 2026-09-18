import { describe, expect, test } from "bun:test";
import { readHandoffDisplay } from "../src/lib/channels/handoff-status";

describe("readHandoffDisplay", () => {
  test("shows an in-flight delegation before the tool result arrives", () => {
    expect(readHandoffDisplay()).toEqual({ state: "running" });
  });

  test("extracts the addressed coworker from an accepted handoff", () => {
    expect(
      readHandoffDisplay(
        "Handed to Risk Analyst. Its answer will be relayed back into this conversation when it finishes.",
      ),
    ).toEqual({ state: "accepted", target: "Risk Analyst" });
  });

  test("treats every other completed handoff result as a refusal", () => {
    expect(
      readHandoffDisplay(
        "You have not been given Risk Analyst to hand work to. An administrator grants that.",
      ),
    ).toEqual({
      state: "refused",
      reason:
        "You have not been given Risk Analyst to hand work to. An administrator grants that.",
    });
  });
});
