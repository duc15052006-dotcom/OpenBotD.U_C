import type { AgentLedgerEntry } from "./model";

export type OperatingCostCategory =
  | "AI_INFERENCE"
  | "VM_COMPUTER"
  | "API"
  | "DOMAIN"
  | "TOOL"
  | "TRANSACTION_FEE"
  | "OTHER";

export interface AttributedOperatingCost {
  entry: AgentLedgerEntry;
  category: OperatingCostCategory;
  projectId?: string;
  revenueAdapterId?: string;
}

export interface CostSummary {
  totalMinor: bigint;
  byCategory: Record<OperatingCostCategory, bigint>;
  byProject: Record<string, bigint>;
  byRevenueAdapter: Record<string, bigint>;
}

const emptyCategories = (): Record<OperatingCostCategory, bigint> => ({
  AI_INFERENCE: 0n,
  VM_COMPUTER: 0n,
  API: 0n,
  DOMAIN: 0n,
  TOOL: 0n,
  TRANSACTION_FEE: 0n,
  OTHER: 0n,
});

function add(
  target: Record<string, bigint>,
  key: string | undefined,
  amountMinor: bigint,
): void {
  if (!key) return;
  target[key] = (target[key] ?? 0n) + amountMinor;
}

export function summarizeOperatingCosts(
  agentId: string,
  costs: readonly AttributedOperatingCost[],
): CostSummary {
  const byCategory = emptyCategories();
  const byProject: Record<string, bigint> = {};
  const byRevenueAdapter: Record<string, bigint> = {};
  let totalMinor = 0n;

  for (const cost of costs) {
    const { entry } = cost;

    if (entry.agentId !== agentId) {
      throw new Error(
        `cost entry ${entry.id} belongs to another agent; cross-agent attribution is forbidden`,
      );
    }
    if (entry.type !== "operating_cost") {
      throw new Error(`cost entry ${entry.id} is not an operating cost`);
    }
    if (entry.direction !== "debit") {
      throw new Error(`cost entry ${entry.id} must be a debit`);
    }
    if (entry.amountMinor <= 0n) {
      throw new Error(`cost entry ${entry.id} must have a positive amount`);
    }
    if (entry.status !== "settled") continue;

    totalMinor += entry.amountMinor;
    byCategory[cost.category] += entry.amountMinor;
    add(byProject, cost.projectId, entry.amountMinor);
    add(byRevenueAdapter, cost.revenueAdapterId, entry.amountMinor);
  }

  return { totalMinor, byCategory, byProject, byRevenueAdapter };
}
