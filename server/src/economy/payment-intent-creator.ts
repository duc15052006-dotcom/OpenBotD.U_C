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
}

export type PaymentIntentCreationSnapshotLoader = (input: {
  agentId: string;
  accountId: string;
}) => Promise<PaymentIntentCreationSnapshot>;

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

function sameImmutableRequest(
  existing: CreatedPaymentIntent,
  input: {
    accountId: string;
    idempotencyKey: string;
    intent: PaymentIntent;
    initiator: PaymentIntentInitiator;
    assetCode: string;
    provider: string;
  },
): boolean {
  return (
    existing.agentId === input.intent.agentId &&
    existing.accountId === input.accountId &&
    existing.idempotencyKey === input.idempotencyKey &&
    existing.kind === input.intent.kind &&
    existing.amountMinor === input.intent.amountMinor &&
    existing.assetCode === input.assetCode &&
    existing.provider === input.provider &&
    existing.destination === input.intent.destination &&
    existing.category === input.intent.category &&
    (existing.x402Domain ?? undefined) ===
      (input.intent.x402Domain ?? undefined) &&
    existing.initiatorKind === input.initiator.kind &&
    existing.initiatorId === initiatorId(input.initiator)
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
  loadSnapshot: PaymentIntentCreationSnapshotLoader,
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

      const existing = await loadByIdempotency(idempotencyKey);
      if (existing) {
        if (
          !sameImmutableRequest(existing, {
            accountId: account.id,
            idempotencyKey,
            intent: input.intent,
            initiator: input.initiator,
            assetCode: account.assetCode,
            provider: account.provider,
          })
        ) {
          throw new PaymentIntentCreationConflictError(idempotencyKey);
        }
        return existing;
      }

      const snapshot = await loadSnapshot({
        agentId: input.intent.agentId,
        accountId: account.id,
      });
      if (snapshot.version <= 0) {
        throw new PaymentIntentCreationInvalidError(
          "Payment intent policy snapshot is invalid.",
        );
      }

      const decision = decidePaymentIntent({
        intent: input.intent,
        policy: snapshot.policy,
        settledBalanceMinor: snapshot.settledBalanceMinor,
        availableDistributableProfitMinor:
          snapshot.availableDistributableProfitMinor,
        spend: snapshot.spend,
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
        policyVersion: snapshot.version,
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
      if (
        !stored ||
        !sameImmutableRequest(stored, {
          accountId: account.id,
          idempotencyKey,
          intent: input.intent,
          initiator: input.initiator,
          assetCode: account.assetCode,
          provider: account.provider,
        })
      ) {
        throw new PaymentIntentCreationConflictError(idempotencyKey);
      }

      return stored;
    },
  };
}
