import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentFinancialAccounts,
  agentPaymentIntents,
  agentProfiles,
} from "../db/schema";
import {
  decidePaymentIntent,
  type EconomyExecutionPolicy,
  type PaymentIntent,
  type SpendWindow,
} from "./intents";
import type { DurablePaymentIntent } from "./payment-intent-store";

export type PaymentIntentInitiator =
  | { kind: "person"; id: string }
  | { kind: "deployment" }
  | { kind: "routine"; id: string }
  | { kind: "handoff"; id: string };

export interface PaymentIntentCreationSnapshot {
  version: number;
  policy: EconomyExecutionPolicy;
  settledBalanceMinor: bigint;
  availableDistributableProfitMinor: bigint;
  spend: SpendWindow;
}

export interface CreatePaymentIntentInput {
  accountId: string;
  idempotencyKey: string;
  intent: PaymentIntent;
  initiator: PaymentIntentInitiator;
  metadata?: Record<string, unknown>;
  snapshot: PaymentIntentCreationSnapshot;
}

export interface CreatedPaymentIntent extends DurablePaymentIntent {
  decisionReason: string;
  initiatorKind: PaymentIntentInitiator["kind"];
  initiatorId: string | null;
  requestedAt: Date;
}

export class PaymentIntentCreationConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(
      `Payment intent idempotency key ${idempotencyKey} conflicts with durable history.`,
    );
    this.name = "PaymentIntentCreationConflictError";
  }
}

export class PaymentIntentAccountForbiddenError extends Error {
  constructor() {
    super("Payment intent account was not found for the active Agent.");
    this.name = "PaymentIntentAccountForbiddenError";
  }
}

export class PaymentIntentCreationInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentIntentCreationInvalidError";
  }
}

function initiatorId(initiator: PaymentIntentInitiator): string | null {
  return initiator.kind === "deployment" ? null : initiator.id;
}

function validInitiator(initiator: PaymentIntentInitiator): boolean {
  return initiator.kind === "deployment" || Boolean(initiator.id.trim());
}

function sameCreatedIntent(
  existing: CreatedPaymentIntent,
  expected: Omit<CreatedPaymentIntent, "id" | "requestedAt">,
): boolean {
  return (
    existing.agentId === expected.agentId &&
    existing.accountId === expected.accountId &&
    existing.idempotencyKey === expected.idempotencyKey &&
    existing.kind === expected.kind &&
    existing.amountMinor === expected.amountMinor &&
    existing.assetCode === expected.assetCode &&
    existing.provider === expected.provider &&
    existing.destination === expected.destination &&
    existing.category === expected.category &&
    (existing.x402Domain ?? undefined) ===
      (expected.x402Domain ?? undefined) &&
    existing.decision === expected.decision &&
    existing.policyVersion === expected.policyVersion &&
    existing.decisionReason === expected.decisionReason &&
    existing.initiatorKind === expected.initiatorKind &&
    existing.initiatorId === expected.initiatorId
  );
}

function parseRow(row: {
  id: string;
  agentId: string;
  accountId: string;
  idempotencyKey: string;
  kind: string;
  amountMinor: string;
  destination: string;
  category: string;
  x402Domain: string | null;
  decision: string;
  decisionReason: string;
  policyVersion: number;
  initiatorKind: string;
  initiatorId: string | null;
  requestedAt: Date;
  assetCode: string;
  provider: string;
}): CreatedPaymentIntent | null {
  if (
    row.kind !== "OPERATING_EXPENSE" &&
    row.kind !== "OWNER_PAYOUT" &&
    row.kind !== "CHILD_FUNDING" &&
    row.kind !== "X402_PAYMENT"
  ) {
    return null;
  }
  if (
    row.decision !== "ALLOW" &&
    row.decision !== "OWNER_CONFIRMATION" &&
    row.decision !== "DENY"
  ) {
    return null;
  }
  if (
    row.initiatorKind !== "person" &&
    row.initiatorKind !== "deployment" &&
    row.initiatorKind !== "routine" &&
    row.initiatorKind !== "handoff"
  ) {
    return null;
  }

  let amountMinor: bigint;
  try {
    amountMinor = BigInt(row.amountMinor);
  } catch {
    return null;
  }

  if (
    amountMinor <= 0n ||
    row.policyVersion <= 0 ||
    !row.idempotencyKey.trim() ||
    !row.assetCode.trim() ||
    !row.provider.trim() ||
    !row.destination.trim() ||
    !row.category.trim() ||
    !row.decisionReason.trim() ||
    Number.isNaN(row.requestedAt.getTime())
  ) {
    return null;
  }

  return {
    id: row.id,
    agentId: row.agentId,
    accountId: row.accountId,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind,
    amountMinor,
    assetCode: row.assetCode,
    provider: row.provider,
    destination: row.destination,
    category: row.category,
    ...(row.x402Domain ? { x402Domain: row.x402Domain } : {}),
    decision: row.decision,
    policyVersion: row.policyVersion,
    decisionReason: row.decisionReason,
    initiatorKind: row.initiatorKind,
    initiatorId: row.initiatorId,
    requestedAt: row.requestedAt,
  };
}

export interface PaymentIntentCreator {
  create(input: CreatePaymentIntentInput): Promise<CreatedPaymentIntent>;
}

export function createPaymentIntentCreator(
  database: Database,
): PaymentIntentCreator {
  const loadByIdempotency = async (
    idempotencyKey: string,
  ): Promise<CreatedPaymentIntent | null> => {
    const [row] = await database
      .select({
        id: agentPaymentIntents.id,
        agentId: agentPaymentIntents.agentId,
        accountId: agentPaymentIntents.accountId,
        idempotencyKey: agentPaymentIntents.idempotencyKey,
        kind: agentPaymentIntents.kind,
        amountMinor: agentPaymentIntents.amountMinor,
        destination: agentPaymentIntents.destination,
        category: agentPaymentIntents.category,
        x402Domain: agentPaymentIntents.x402Domain,
        decision: agentPaymentIntents.decision,
        decisionReason: agentPaymentIntents.decisionReason,
        policyVersion: agentPaymentIntents.policyVersion,
        initiatorKind: agentPaymentIntents.initiatorKind,
        initiatorId: agentPaymentIntents.initiatorId,
        requestedAt: agentPaymentIntents.requestedAt,
        assetCode: agentFinancialAccounts.assetCode,
        provider: agentFinancialAccounts.provider,
      })
      .from(agentPaymentIntents)
      .innerJoin(
        agentFinancialAccounts,
        and(
          eq(agentFinancialAccounts.id, agentPaymentIntents.accountId),
          eq(agentFinancialAccounts.agentId, agentPaymentIntents.agentId),
        ),
      )
      .where(eq(agentPaymentIntents.idempotencyKey, idempotencyKey))
      .limit(1);

    return row ? parseRow(row) : null;
  };

  return {
    async create(input) {
      const idempotencyKey = input.idempotencyKey.trim();
      if (
        !idempotencyKey ||
        !input.accountId.trim() ||
        !input.intent.agentId.trim() ||
        input.intent.amountMinor <= 0n ||
        !input.intent.destination.trim() ||
        !input.intent.category.trim() ||
        input.snapshot.version <= 0 ||
        !validInitiator(input.initiator)
      ) {
        throw new PaymentIntentCreationInvalidError(
          "Payment intent creation input is invalid.",
        );
      }

      const [account] = await database
        .select({
          id: agentFinancialAccounts.id,
          agentId: agentFinancialAccounts.agentId,
          assetCode: agentFinancialAccounts.assetCode,
          provider: agentFinancialAccounts.provider,
          profileAgentId: agentProfiles.agentId,
        })
        .from(agentFinancialAccounts)
        .leftJoin(
          agentProfiles,
          and(
            eq(agentProfiles.agentId, agentFinancialAccounts.agentId),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .where(
          and(
            eq(agentFinancialAccounts.id, input.accountId),
            eq(agentFinancialAccounts.agentId, input.intent.agentId),
          ),
        )
        .limit(1);

      if (
        !account?.profileAgentId ||
        !account.assetCode.trim() ||
        !account.provider.trim()
      ) {
        throw new PaymentIntentAccountForbiddenError();
      }

      const decision = decidePaymentIntent({
        intent: input.intent,
        policy: input.snapshot.policy,
        settledBalanceMinor: input.snapshot.settledBalanceMinor,
        availableDistributableProfitMinor:
          input.snapshot.availableDistributableProfitMinor,
        spend: input.snapshot.spend,
      });

      const expected: Omit<CreatedPaymentIntent, "id" | "requestedAt"> = {
        agentId: input.intent.agentId,
        accountId: account.id,
        idempotencyKey,
        kind: input.intent.kind,
        amountMinor: input.intent.amountMinor,
        assetCode: account.assetCode,
        provider: account.provider,
        destination: input.intent.destination,
        category: input.intent.category,
        ...(input.intent.x402Domain
          ? { x402Domain: input.intent.x402Domain }
          : {}),
        decision: decision.decision,
        policyVersion: input.snapshot.version,
        decisionReason: decision.reason,
        initiatorKind: input.initiator.kind,
        initiatorId: initiatorId(input.initiator),
      };

      await database
        .insert(agentPaymentIntents)
        .values({
          agentId: expected.agentId,
          accountId: expected.accountId,
          idempotencyKey: expected.idempotencyKey,
          kind: expected.kind,
          amountMinor: expected.amountMinor.toString(),
          destination: expected.destination,
          category: expected.category,
          x402Domain: expected.x402Domain ?? null,
          decision: expected.decision,
          decisionReason: expected.decisionReason,
          policyVersion: expected.policyVersion,
          initiatorKind: input.initiator.kind,
          initiatorId: initiatorId(input.initiator),
          metadata: input.metadata ?? {},
        })
        .onConflictDoNothing({ target: agentPaymentIntents.idempotencyKey });

      const stored = await loadByIdempotency(idempotencyKey);
      if (!stored || !sameCreatedIntent(stored, expected)) {
        throw new PaymentIntentCreationConflictError(idempotencyKey);
      }

      return stored;
    },
  };
}
