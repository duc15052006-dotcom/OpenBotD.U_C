export interface Money {
  assetCode: string;
  amountMinor: bigint;
}

export interface TransferRequest {
  idempotencyKey: string;
  amount: Money;
  destination: string;
}

export interface PreparedTransfer {
  id: string;
  request: TransferRequest;
}

export interface TransferReceipt {
  transferId: string;
  idempotencyKey: string;
  amount: Money;
  destination: string;
}

export interface PaymentAccountAdapter {
  getBalance(assetCode: string): Promise<Money>;
  prepareTransfer(request: TransferRequest): Promise<PreparedTransfer>;
  executeTransfer(prepared: PreparedTransfer): Promise<TransferReceipt>;
  verifyTransfer(receipt: TransferReceipt): Promise<boolean>;
}

/**
 * Deterministic E2 adapter used for policy/integration tests only.
 *
 * It has no network, key material, chain client or provider credential. E3 real adapters must
 * implement the same interface behind the Economy Gateway rather than being handed to an Agent.
 */
export class InMemoryPaymentAccountAdapter implements PaymentAccountAdapter {
  private readonly balances = new Map<string, bigint>();
  private readonly prepared = new Map<string, PreparedTransfer>();
  private readonly receipts = new Map<string, TransferReceipt>();

  constructor(initialBalances: Record<string, bigint>) {
    for (const [assetCode, amountMinor] of Object.entries(initialBalances)) {
      if (amountMinor < 0n) {
        throw new Error("initial balance must not be negative");
      }
      this.balances.set(assetCode, amountMinor);
    }
  }

  async getBalance(assetCode: string): Promise<Money> {
    return {
      assetCode,
      amountMinor: this.balances.get(assetCode) ?? 0n,
    };
  }

  async prepareTransfer(request: TransferRequest): Promise<PreparedTransfer> {
    if (request.amount.amountMinor <= 0n) {
      throw new Error("transfer amount must be positive");
    }
    if (!request.idempotencyKey.trim()) {
      throw new Error("idempotency key is required");
    }
    if (!request.destination.trim()) {
      throw new Error("transfer destination is required");
    }

    const existingReceipt = this.receipts.get(request.idempotencyKey);
    if (existingReceipt) {
      return {
        id: existingReceipt.transferId,
        request: {
          idempotencyKey: existingReceipt.idempotencyKey,
          amount: existingReceipt.amount,
          destination: existingReceipt.destination,
        },
      };
    }

    const existing = this.prepared.get(request.idempotencyKey);
    if (existing) {
      if (
        existing.request.amount.assetCode !== request.amount.assetCode ||
        existing.request.amount.amountMinor !== request.amount.amountMinor ||
        existing.request.destination !== request.destination
      ) {
        throw new Error(
          "idempotency key was already used for another transfer",
        );
      }
      return existing;
    }

    const prepared = {
      id: `mock:${request.idempotencyKey}`,
      request: {
        ...request,
        amount: { ...request.amount },
      },
    };
    this.prepared.set(request.idempotencyKey, prepared);
    return prepared;
  }

  async executeTransfer(prepared: PreparedTransfer): Promise<TransferReceipt> {
    const { request } = prepared;
    const known = this.prepared.get(request.idempotencyKey);
    if (!known || known.id !== prepared.id) {
      throw new Error("transfer was not prepared by this adapter");
    }

    const existing = this.receipts.get(request.idempotencyKey);
    if (existing) return existing;

    const balance = this.balances.get(request.amount.assetCode) ?? 0n;
    if (balance < request.amount.amountMinor) {
      throw new Error("insufficient mock balance");
    }

    this.balances.set(
      request.amount.assetCode,
      balance - request.amount.amountMinor,
    );

    const receipt = {
      transferId: prepared.id,
      idempotencyKey: request.idempotencyKey,
      amount: { ...request.amount },
      destination: request.destination,
    };
    this.receipts.set(request.idempotencyKey, receipt);
    return receipt;
  }

  async verifyTransfer(receipt: TransferReceipt): Promise<boolean> {
    const stored = this.receipts.get(receipt.idempotencyKey);
    return (
      stored?.transferId === receipt.transferId &&
      stored.amount.assetCode === receipt.amount.assetCode &&
      stored.amount.amountMinor === receipt.amount.amountMinor &&
      stored.destination === receipt.destination
    );
  }
}
