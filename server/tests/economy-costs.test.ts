import { describe, expect, test } from "bun:test";
import type { AgentLedgerEntry } from "../src/economy/model";
import { summarizeOperatingCosts } from "../src/economy/costs";

function costEntry(
  id: string,
  amountMinor: bigint,
  status: AgentLedgerEntry["status"] = "settled",
): AgentLedgerEntry {
  return {
    id,
    agentId: "agent-a",
    accountId: "account-a",
    idempotencyKey: `cost-${id}`,
    type: "operating_cost",
    direction: "debit",
    status,
    amountMinor,
    assetCode: "USDC",
    assetClass: "STABLECOIN",
    redeemable: true,
    occurredAt: new Date("2026-09-27T00:00:00Z"),
  };
}

describe("Agent Economy cost attribution", () => {
  test("attributes settled costs by category, project and revenue adapter", () => {
    const summary = summarizeOperatingCosts("agent-a", [
      {
        entry: costEntry("ai", 6_000n),
        category: "AI_INFERENCE",
        projectId: "project-one",
        revenueAdapterId: "saas",
      },
      {
        entry: costEntry("vm", 2_500n),
        category: "VM_COMPUTER",
        projectId: "project-one",
      },
      {
        entry: costEntry("api", 1_500n),
        category: "API",
        projectId: "project-two",
        revenueAdapterId: "saas",
      },
      {
        entry: costEntry("pending", 99_999n, "pending"),
        category: "OTHER",
      },
    ]);

    expect(summary.totalMinor).toBe(10_000n);
    expect(summary.byCategory.AI_INFERENCE).toBe(6_000n);
    expect(summary.byCategory.VM_COMPUTER).toBe(2_500n);
    expect(summary.byCategory.API).toBe(1_500n);
    expect(summary.byCategory.OTHER).toBe(0n);
    expect(summary.byProject).toEqual({
      "project-one": 8_500n,
      "project-two": 1_500n,
    });
    expect(summary.byRevenueAdapter).toEqual({ saas: 7_500n });
  });

  test("refuses cross-agent cost attribution", () => {
    const entry = { ...costEntry("foreign", 100n), agentId: "agent-b" };
    expect(() =>
      summarizeOperatingCosts("agent-a", [
        { entry, category: "OTHER" },
      ]),
    ).toThrow("cross-agent attribution is forbidden");
  });
});
