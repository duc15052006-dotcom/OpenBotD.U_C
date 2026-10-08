import { describe, expect, test } from "bun:test";

import {
  inspectedNanoCpus,
  inspectedRestartPolicyName,
  networkModeNeedsRecreation,
} from "./resource-inspect";

describe("Docker-compatible resource inspection", () => {
  test("reads Docker NanoCpus directly", () => {
    expect(
      inspectedNanoCpus({
        NanoCpus: 2_000_000_000,
        CpuPeriod: 100_000,
        CpuQuota: 100_000,
      }),
    ).toBe(2_000_000_000);
  });

  test("derives Podman CPU limits from period and quota when NanoCpus is zero", () => {
    expect(
      inspectedNanoCpus({
        NanoCpus: 0,
        CpuPeriod: 100_000,
        CpuQuota: 200_000,
      }),
    ).toBe(2_000_000_000);
    expect(
      inspectedNanoCpus({
        NanoCpus: 0,
        CpuPeriod: 100_000,
        CpuQuota: 300_000,
      }),
    ).toBe(3_000_000_000);
  });

  test("keeps an explicit unlimited CPU representation as zero", () => {
    expect(
      inspectedNanoCpus({
        NanoCpus: 0,
        CpuPeriod: 0,
        CpuQuota: 0,
      }),
    ).toBe(0);
  });

  test("treats an omitted no-restart name as OpenBot-owned lifecycle", () => {
    expect(inspectedRestartPolicyName(undefined)).toBe("no");
    expect(inspectedRestartPolicyName("")).toBe("no");
    expect(inspectedRestartPolicyName("no")).toBe("no");
    expect(inspectedRestartPolicyName("unless-stopped")).toBe("unless-stopped");
  });
});

describe("Computer network resume", () => {
  test("recognizes both default bridge spellings without recycling an owned Computer", () => {
    expect(networkModeNeedsRecreation("bridge", undefined)).toBe(false);
    expect(networkModeNeedsRecreation("default", undefined)).toBe(false);
    expect(networkModeNeedsRecreation("pasta", undefined)).toBe(false);
    expect(networkModeNeedsRecreation("slirp4netns", undefined)).toBe(false);
    expect(networkModeNeedsRecreation(undefined, undefined)).toBe(false);
  });

  test("requires a new container when joining, leaving or switching networks", () => {
    expect(networkModeNeedsRecreation("bridge", "new-network")).toBe(true);
    expect(networkModeNeedsRecreation("old-network", "new-network")).toBe(true);
    expect(networkModeNeedsRecreation("old-network", undefined)).toBe(true);
    expect(networkModeNeedsRecreation(undefined, "new-network")).toBe(true);
    expect(networkModeNeedsRecreation("new-network", "new-network")).toBe(
      false,
    );
  });
});
