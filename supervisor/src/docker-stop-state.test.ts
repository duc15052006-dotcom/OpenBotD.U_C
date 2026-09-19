import { describe, expect, test } from "bun:test";
import { wasRunningBeforeStop } from "./stop-state";

describe("Computer Stop state classification", () => {
  test("reports only a running container as wasRunning", () => {
    expect(wasRunningBeforeStop("running")).toBe(true);
    expect(wasRunningBeforeStop("RUNNING")).toBe(true);

    for (const status of [
      "created",
      "restarting",
      "paused",
      "removing",
      "exited",
      "dead",
      "unknown",
    ]) {
      expect(wasRunningBeforeStop(status)).toBe(false);
    }
  });
});
