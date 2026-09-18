import { describe, expect, test } from "bun:test";
import {
  cpuCapacityFromMax,
  cpuUsageUsecFromStat,
} from "../src/metrics";

describe("computer metrics parsing", () => {
  test("reads cgroup v2 CPU usage without confusing the other counters", () => {
    expect(
      cpuUsageUsecFromStat(
        "usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\nnr_periods 9",
      ),
    ).toBe(123456);
    expect(cpuUsageUsecFromStat("user_usec 1\nsystem_usec 2")).toBeNull();
  });

  test("normalizes CPU against the configured cgroup quota", () => {
    expect(cpuCapacityFromMax("200000 100000", 8)).toBe(2);
    expect(cpuCapacityFromMax("50000 100000", 8)).toBe(0.5);
    expect(cpuCapacityFromMax("max 100000", 8)).toBe(8);
    expect(cpuCapacityFromMax(null, 4)).toBe(4);
  });
});
