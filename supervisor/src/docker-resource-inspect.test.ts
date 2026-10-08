import { describe, expect, test } from "bun:test";

import {
  computerResourcesMatch,
  inspectedNanoCpus,
  inspectedRestartPolicyName,
  reconcileComputerResources,
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

describe("Computer resource reconciliation", () => {
  const requested = {
    memoryBytes: 4_294_967_296,
    nanoCpus: 2_000_000_000,
  };

  test("accepts an exact inspected profile without touching the container", async () => {
    let updates = 0;
    let replacements = 0;
    const existing = {
      ...requested,
      restartPolicyName: "no",
    };

    const result = await reconcileComputerResources(
      existing,
      requested,
      async () => {
        updates += 1;
        return existing;
      },
      async () => {
        replacements += 1;
      },
    );

    expect(result).toBe(existing);
    expect(updates).toBe(0);
    expect(replacements).toBe(0);
  });

  test("keeps the container when an in-place update becomes exact", async () => {
    let replacements = 0;
    const updated = {
      ...requested,
      restartPolicyName: "no",
    };

    const result = await reconcileComputerResources(
      {
        memoryBytes: 2_147_483_648,
        nanoCpus: 1_000_000_000,
        restartPolicyName: "unless-stopped",
      },
      requested,
      async () => updated,
      async () => {
        replacements += 1;
      },
    );

    expect(result).toBe(updated);
    expect(replacements).toBe(0);
  });

  test("falls back to a container-only replacement when Podman refuses update", async () => {
    let replacements = 0;

    const result = await reconcileComputerResources(
      {
        memoryBytes: 2_147_483_648,
        nanoCpus: 1_000_000_000,
        restartPolicyName: "no",
      },
      requested,
      async () => {
        throw new Error("synthetic Podman update refusal");
      },
      async () => {
        replacements += 1;
      },
    );

    expect(result).toBeNull();
    expect(replacements).toBe(1);
  });

  test("replaces when the compatibility API accepts update but still reports drift", async () => {
    let replacements = 0;

    const result = await reconcileComputerResources(
      {
        memoryBytes: 2_147_483_648,
        nanoCpus: 1_000_000_000,
        restartPolicyName: "no",
      },
      requested,
      async () => ({
        memoryBytes: requested.memoryBytes,
        // Simulate a compatibility API that did not apply/report the requested quota.
        nanoCpus: 1_000_000_000,
        restartPolicyName: "no",
      }),
      async () => {
        replacements += 1;
      },
    );

    expect(result).toBeNull();
    expect(replacements).toBe(1);
  });

  test("normalizes an omitted restart policy to OpenBot-owned no-restart", () => {
    expect(
      computerResourcesMatch(
        {
          ...requested,
          restartPolicyName: undefined,
        },
        requested,
      ),
    ).toBe(true);
  });
});
