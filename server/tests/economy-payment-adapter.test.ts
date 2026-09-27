import { describe, expect, test } from "bun:test";
import { InMemoryPaymentAccountAdapter } from "../src/economy/payment-adapter";

describe("Agent Economy mock payment adapter", () => {
  test("executes an approved mock transfer exactly once", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 10_000n });
    const prepared = await adapter.prepareTransfer({
      idempotencyKey: "intent-1",
      amount: { assetCode: "USDC", amountMinor: 2_500n },
      destination: "vendor-wallet",
    });

    const first = await adapter.executeTransfer(prepared);
    const second = await adapter.executeTransfer(prepared);

    expect(second).toEqual(first);
    expect(await adapter.verifyTransfer(first)).toBe(true);
    expect(await adapter.getBalance("USDC")).toEqual({
      assetCode: "USDC",
      amountMinor: 7_500n,
    });
  });

  test("refuses reuse of an idempotency key for different transfer terms", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 10_000n });
    await adapter.prepareTransfer({
      idempotencyKey: "intent-1",
      amount: { assetCode: "USDC", amountMinor: 1_000n },
      destination: "vendor-wallet",
    });

    await expect(
      adapter.prepareTransfer({
        idempotencyKey: "intent-1",
        amount: { assetCode: "USDC", amountMinor: 2_000n },
        destination: "vendor-wallet",
      }),
    ).rejects.toThrow("idempotency key was already used for another transfer");
  });

  test("has no implicit overdraft", async () => {
    const adapter = new InMemoryPaymentAccountAdapter({ USDC: 1_000n });
    const prepared = await adapter.prepareTransfer({
      idempotencyKey: "intent-2",
      amount: { assetCode: "USDC", amountMinor: 1_001n },
      destination: "vendor-wallet",
    });

    await expect(adapter.executeTransfer(prepared)).rejects.toThrow(
      "insufficient mock balance",
    );
    expect((await adapter.getBalance("USDC")).amountMinor).toBe(1_000n);
  });

  test("cannot execute a transfer prepared by another adapter", async () => {
    const left = new InMemoryPaymentAccountAdapter({ USDC: 10_000n });
    const right = new InMemoryPaymentAccountAdapter({ USDC: 10_000n });
    const prepared = await left.prepareTransfer({
      idempotencyKey: "intent-3",
      amount: { assetCode: "USDC", amountMinor: 500n },
      destination: "vendor-wallet",
    });

    await expect(right.executeTransfer(prepared)).rejects.toThrow(
      "transfer was not prepared by this adapter",
    );
  });
});
