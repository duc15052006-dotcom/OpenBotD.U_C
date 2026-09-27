import { validateTreasuryPolicy, type TreasuryPolicy } from "./model";

export type PaymentIntentKind =
  | "OPERATING_EXPENSE"
  | "OWNER_PAYOUT"
  | "CHILD_FUNDING"
  | "X402_PAYMENT";

export type PaymentDecision = "ALLOW" | "OWNER_CONFIRMATION" | "DENY";

export interface EconomyExecutionPolicy extends TreasuryPolicy {
  maxChildFundingMinor: bigint;
  maxX402PaymentMinor: bigint;
  allowedX402Domains: readonly string[];
}

export interface SpendWindow {
  hourlyMinor: bigint;
  dailyMinor: bigint;
  monthlyMinor: bigint;
}

export interface PaymentIntent {
  agentId: string;
  kind: PaymentIntentKind;
  amountMinor: bigint;
  destination: string;
  category: string;
  x402Domain?: string;
}

export interface PaymentDecisionResult {
  decision: PaymentDecision;
  reason: string;
}

function deny(reason: string): PaymentDecisionResult {
  return { decision: "DENY", reason };
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function allowedDomain(domain: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeDomain(domain);
  return allowlist.some((candidate) => {
    const allowed = normalizeDomain(candidate);
    if (!allowed) return false;
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}

export function decidePaymentIntent(input: {
  intent: PaymentIntent;
  policy: EconomyExecutionPolicy;
  settledBalanceMinor: bigint;
  availableDistributableProfitMinor: bigint;
  spend: SpendWindow;
}): PaymentDecisionResult {
  const { intent, policy } = input;

  const policyErrors = validateTreasuryPolicy(policy);
  if (policy.maxChildFundingMinor < 0n) {
    policyErrors.push("maxChildFundingMinor must not be negative");
  }
  if (policy.maxX402PaymentMinor < 0n) {
    policyErrors.push("maxX402PaymentMinor must not be negative");
  }
  if (policyErrors.length > 0) {
    return deny(`invalid financial policy: ${policyErrors.join("; ")}`);
  }

  if (
    input.spend.hourlyMinor < 0n ||
    input.spend.dailyMinor < 0n ||
    input.spend.monthlyMinor < 0n
  ) {
    return deny("invalid spend history");
  }

  if (policy.frozen) return deny("financial activity is frozen");
  if (intent.amountMinor <= 0n) return deny("payment amount must be positive");
  if (input.settledBalanceMinor < 0n) return deny("agent is insolvent");

  if (intent.amountMinor > policy.maxPaymentPerTransactionMinor) {
    return deny("payment exceeds per-transaction limit");
  }
  if (
    input.spend.hourlyMinor + intent.amountMinor >
    policy.maxHourlySpendMinor
  ) {
    return deny("payment exceeds hourly spend limit");
  }
  if (input.spend.dailyMinor + intent.amountMinor > policy.maxDailySpendMinor) {
    return deny("payment exceeds daily spend limit");
  }
  if (
    input.spend.monthlyMinor + intent.amountMinor >
    policy.maxMonthlySpendMinor
  ) {
    return deny("payment exceeds monthly spend limit");
  }

  if (
    input.settledBalanceMinor - intent.amountMinor <
    policy.minimumReserveMinor
  ) {
    return deny("payment would breach minimum reserve");
  }

  if (
    policy.allowedPaymentCategories.length > 0 &&
    !policy.allowedPaymentCategories.includes(intent.category)
  ) {
    return deny("payment category is not allowed");
  }

  if (
    policy.allowedPaymentAddresses.length > 0 &&
    !policy.allowedPaymentAddresses.includes(intent.destination)
  ) {
    return deny("payment destination is not whitelisted");
  }

  switch (intent.kind) {
    case "OWNER_PAYOUT":
      if (intent.amountMinor > input.availableDistributableProfitMinor) {
        return deny("owner payout exceeds distributable profit");
      }
      break;
    case "CHILD_FUNDING":
      if (intent.amountMinor > policy.maxChildFundingMinor) {
        return deny("child funding exceeds configured limit");
      }
      break;
    case "X402_PAYMENT":
      if (intent.amountMinor > policy.maxX402PaymentMinor) {
        return deny("x402 payment exceeds configured limit");
      }
      if (!intent.x402Domain) {
        return deny("x402 payment requires a destination domain");
      }
      if (
        policy.allowedX402Domains.length === 0 ||
        !allowedDomain(intent.x402Domain, policy.allowedX402Domains)
      ) {
        return deny("x402 destination domain is not allowed");
      }
      break;
    case "OPERATING_EXPENSE":
      break;
  }

  if (intent.amountMinor > policy.ownerConfirmationThresholdMinor) {
    return {
      decision: "OWNER_CONFIRMATION",
      reason: "payment exceeds Owner confirmation threshold",
    };
  }

  return { decision: "ALLOW", reason: "financial policy allows payment" };
}
