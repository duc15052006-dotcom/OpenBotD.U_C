import { describe, expect, test } from "bun:test";
import {
  encryptSecret,
  type PaymentCredentialSecretReader,
} from "../src/credentials";
import type { Database } from "../src/db/client";
import {
  createPaymentAdapterResolver,
  PaymentAdapterResolutionError,
} from "../src/economy/payment-adapter-resolver";

const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const circleCredential = {
  apiKey: "TEST_API_KEY:test:test",
  entitySecretHex: "11".repeat(32),
  walletId: "wallet-id",
  tokenId: "usdc-token",
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  blockchain: "BASE-SEPOLIA",
};

function fakeDatabase(overrides: Record<string, unknown> = {}): Database {
  const row = {
    id: "account-a",
    agentId: "agent-a",
    assetCode: "USDC",
    provider: "circle",
    network: "BASE-SEPOLIA",
    credentialId: "credential-a",
    profileAgentId: "agent-a",
    ...overrides,
  };
  return {
    select() {
      return {
        from() {
          return {
            leftJoin() {
              return {
                where() {
                  return {
                    async limit() {
                      return [row];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

async function reader(
  plaintext = JSON.stringify(circleCredential),
  revokedAt: Date | null = null,
): Promise<PaymentCredentialSecretReader> {
  return {
    readPaymentSecret: async () => ({
      encryptedValue: await encryptSecret(ENCRYPTION_KEY, plaintext),
      revokedAt,
    }),
  };
}

describe("Agent Economy payment adapter resolver", () => {
  test("resolves a matching Circle testnet account without network fallback", async () => {
    const resolver = createPaymentAdapterResolver({
      database: fakeDatabase(),
      encryptionKey: ENCRYPTION_KEY,
      credentialReader: await reader(),
    });

    const prepared = await resolver.useForAccount({
      agentId: "agent-a",
      accountId: "account-a",
      use: async (adapter, provider) => {
        expect(provider).toBe("circle");
        return adapter.prepareTransfer({
          idempotencyKey: "intent-1",
          amount: { assetCode: "USDC", amountMinor: 1_000_000n },
          destination: "0x1111111111111111111111111111111111111111",
        });
      },
    });

    expect(prepared.id).toMatch(/^circle:/);
  });

  test("does not expose internal or mock accounts through live execution", async () => {
    const resolver = createPaymentAdapterResolver({
      database: fakeDatabase({
        provider: "internal",
        network: "none",
        credentialId: null,
      }),
      encryptionKey: ENCRYPTION_KEY,
      credentialReader: await reader(),
    });

    await expect(
      resolver.useForAccount({
        agentId: "agent-a",
        accountId: "account-a",
        use: async () => null,
      }),
    ).rejects.toBeInstanceOf(PaymentAdapterResolutionError);
  });

  test("binds the Circle credential asset and network to the durable account", async () => {
    const assetResolver = createPaymentAdapterResolver({
      database: fakeDatabase({ assetCode: "EURC" }),
      encryptionKey: ENCRYPTION_KEY,
      credentialReader: await reader(),
    });
    await expect(
      assetResolver.useForAccount({
        agentId: "agent-a",
        accountId: "account-a",
        use: async () => null,
      }),
    ).rejects.toThrow(
      "payment credential asset does not match financial account",
    );

    const networkResolver = createPaymentAdapterResolver({
      database: fakeDatabase({ network: "ETH-SEPOLIA" }),
      encryptionKey: ENCRYPTION_KEY,
      credentialReader: await reader(),
    });
    await expect(
      networkResolver.useForAccount({
        agentId: "agent-a",
        accountId: "account-a",
        use: async () => null,
      }),
    ).rejects.toThrow(
      "payment credential network does not match financial account",
    );
  });

  test("refuses inactive Agents and revoked payment credentials", async () => {
    const inactiveResolver = createPaymentAdapterResolver({
      database: fakeDatabase({ profileAgentId: null }),
      encryptionKey: ENCRYPTION_KEY,
      credentialReader: await reader(),
    });
    await expect(
      inactiveResolver.useForAccount({
        agentId: "agent-a",
        accountId: "account-a",
        use: async () => null,
      }),
    ).rejects.toThrow("financial account is unavailable");

    const revokedResolver = createPaymentAdapterResolver({
      database: fakeDatabase(),
      encryptionKey: ENCRYPTION_KEY,
      credentialReader: await reader(
        JSON.stringify(circleCredential),
        new Date("2026-09-28T00:00:00.000Z"),
      ),
    });
    await expect(
      revokedResolver.useForAccount({
        agentId: "agent-a",
        accountId: "account-a",
        use: async () => null,
      }),
    ).rejects.toThrow("Credential is revoked");
  });
});
