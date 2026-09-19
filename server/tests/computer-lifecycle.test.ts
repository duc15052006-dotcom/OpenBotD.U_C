import { describe, expect, test } from "bun:test";
import { computerLifecycleState } from "../src/computer/lifecycle";

describe("Computer lifecycle state", () => {
  test("running container with a resident browser is Running", () => {
    expect(
      computerLifecycleState({ running: true, browserRunning: true }),
    ).toBe("running");
  });

  test("running container whose browser was evicted after idle is Idle", () => {
    expect(
      computerLifecycleState({ running: true, browserRunning: false }),
    ).toBe("idle");
  });

  test("stopped container is Sleeping only when the idle culler put it there", () => {
    expect(
      computerLifecycleState({
        running: false,
        latestEvent: "computer.slept",
      }),
    ).toBe("sleeping");
    expect(
      computerLifecycleState({
        running: false,
        latestEvent: "computer.stopped",
      }),
    ).toBe("stopped");
  });

  test("missing lifecycle provenance fails conservatively to Stopped", () => {
    expect(computerLifecycleState({ running: false })).toBe("stopped");
  });
});
