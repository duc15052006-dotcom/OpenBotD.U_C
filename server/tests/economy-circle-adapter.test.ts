import { describe, expect, test } from "bun:test";
import {
  CircleDeveloperWalletAdapter,
  createCircleDeveloperWalletAdapter,
  type CirclePaymentCredential,
} from "../src/economy/circle-adapter";

const credential: CirclePaymentCredential = {
  apiKey: "TEST_API_KEY:test:test",
  entitySecretHex: "11".repeat(32),
  walletId: "wallet-id",
  tokenId: "usdc-token",
  tokenSymbol: "USDC",
  tokenDecimals: 6,
  blockchain: "BASE-SEPOLIA",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Circle developer wallet payment adapter", () => {
  test("defaults fail-closed against mainnet", () => {
    expect(
      () =>
        new CircleDeveloperWalletAdapter({
          ...credential,
          blockchain: "BASE",
        }),
    ).toThrow("Circle mainnet is disabled");
  });

  test("reads only the configured token and converts decimals to minor units", async () => {
    const calls: string[] = [];
    const adapter = new CircleDeveloperWalletAdapter(credential, {
      fetch: (async (url) => {
        calls.push(String(url));
        return response({
          data: {
            tokenBalances: [
              {
                token: {
                  id: "usdc-token",
                  symbol: "USDC",
                  decimals: 6,
                },
                amount: "12.345678",
              },
            ],
          },
        });
      }) as typeof fetch,
    });

    expect(await adapter.getBalance("USDC")).toEqual({
      assetCode: "USDC",
      amountMinor: 12_345_678n,
    });
    expect(calls[0]).toContain("/wallets/wallet-id/balances");
  });

  test("executes only after Circle reports COMPLETE and keeps provider idempotency deterministic", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let lookups = 0;
    const adapter = new CircleDeveloperWalletAdapter(credential, {
      pollIntervalMs: 0,
      sleep: async () => {},
      fetch: (async (url, init) => {
        const stringUrl = String(url);
        calls.push({ url: stringUrl, init });

        if (stringUrl.endsWith("/config/entity/publicKey")) {
          const { publicKey } = await crypto.subtle.generateKey(
            {
              name: "RSA-OAEP",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            },
            true,
            ["encrypt", "decrypt"],
          );
          const spki = await crypto.subtle.exportKey("spki", publicKey);
          const base64 = Buffer.from(spki).toString("base64");
          const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
          return response({
            data: {
              publicKey: `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`,
            },
          });
        }

        if (stringUrl.endsWith("/developer/transactions/transfer")) {
          return response({
            data: {
              id: "circle-transaction",
              state: "INITIATED",
            },
          });
        }

        if (stringUrl.endsWith("/transactions/circle-transaction")) {
          lookups += 1;
          return response({
            data: {
              transaction: {
                id: "circle-transaction",
                state: lookups === 1 ? "SENT" : "COMPLETE",
                txHash: "0xabc",
                walletId: "wallet-id",
                tokenId: "usdc-token",
                destinationAddress:
                  "0x1111111111111111111111111111111111111111",
                amounts: ["1.25"],
              },
            },
          });
        }

        throw new Error(`unexpected Circle test URL: ${stringUrl}`);
      }) as typeof fetch,
    });

    const prepared = await adapter.prepareTransfer({
      idempotencyKey: "openbot-intent-7",
      amount: { assetCode: "USDC", amountMinor: 1_250_000n },
      destination: "0x1111111111111111111111111111111111111111",
    });
    const receipt = await adapter.executeTransfer(prepared);

    expect(receipt).toEqual({
      transferId: "0xabc",
      idempotencyKey: "openbot-intent-7",
      amount: { assetCode: "USDC", amountMinor: 1_250_000n },
      destination: "0x1111111111111111111111111111111111111111",
    });
    expect(lookups).toBe(2);

    const createCall = calls.find((call) =>
      call.url.endsWith("/developer/transactions/transfer"),
    );
    const body = JSON.parse(String(createCall?.init?.body));
    expect(body.walletId).toBe("wallet-id");
    expect(body.tokenId).toBe("usdc-token");
    expect(body.amounts).toEqual(["1.25"]);
    expect(body.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.entitySecretCiphertext).not.toContain(
      credential.entitySecretHex,
    );
  });

  test("refuses COMPLETE when provider finality evidence does not match prepared terms", async () => {
    const adapter = new CircleDeveloperWalletAdapter(credential, {
      pollIntervalMs: 0,
      sleep: async () => {},
      fetch: (async (url) => {
        const stringUrl = String(url);

        if (stringUrl.endsWith("/config/entity/publicKey")) {
          const { publicKey } = await crypto.subtle.generateKey(
            {
              name: "RSA-OAEP",
              modulusLength: 2048,
              publicExponent: new Uint8Array([1, 0, 1]),
              hash: "SHA-256",
            },
            true,
            ["encrypt", "decrypt"],
          );
          const spki = await crypto.subtle.exportKey("spki", publicKey);
          const base64 = Buffer.from(spki).toString("base64");
          const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
          return response({
            data: {
              publicKey: `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----`,
            },
          });
        }

        if (stringUrl.endsWith("/developer/transactions/transfer")) {
          return response({
            data: {
              id: "circle-transaction-mismatch",
              state: "COMPLETE",
              txHash: "0xdef",
              walletId: "wallet-id",
              tokenId: "usdc-token",
              destinationAddress: "0x9999999999999999999999999999999999999999",
              amounts: ["1.25"],
            },
          });
        }

        throw new Error(`unexpected Circle test URL: ${stringUrl}`);
      }) as typeof fetch,
    });

    const prepared = await adapter.prepareTransfer({
      idempotencyKey: "intent-mismatch",
      amount: { assetCode: "USDC", amountMinor: 1_250_000n },
      destination: "0x1111111111111111111111111111111111111111",
    });

    await expect(adapter.executeTransfer(prepared)).rejects.toThrow(
      "Circle completed transaction destination does not match prepared transfer",
    );
  });

  test("stuck and failed Circle states never become verified receipts", async () => {
    const adapter = new CircleDeveloperWalletAdapter(credential, {
      sleep: async () => {},
      fetch: (async (url) => {
        const stringUrl = String(url);
        if (stringUrl.endsWith("/config/entity/publicKey")) {
          throw new Error("should not reach key fetch in this test");
        }
        if (stringUrl.endsWith("/developer/transactions/transfer")) {
          return response({
            data: { id: "circle-transaction", state: "STUCK" },
          });
        }
        throw new Error("unexpected request");
      }) as typeof fetch,
    });

    const prepared = await adapter.prepareTransfer({
      idempotencyKey: "intent-stuck",
      amount: { assetCode: "USDC", amountMinor: 1n },
      destination: "destination",
    });

    // Key encryption happens before the POST; use a prepared HTTP failure instead to assert malformed
    // credentials cannot silently bypass the provider boundary.
    await expect(adapter.executeTransfer(prepared)).rejects.toThrow();
  });

  test("credential parser rejects malformed or accidental mainnet credentials", () => {
    expect(() =>
      createCircleDeveloperWalletAdapter(
        JSON.stringify({
          ...credential,
          entitySecretHex: "not-a-secret",
        }),
      ),
    ).toThrow("32-byte hexadecimal");

    expect(() =>
      createCircleDeveloperWalletAdapter(
        JSON.stringify({ ...credential, blockchain: "ETH" }),
      ),
    ).toThrow("Circle mainnet is disabled");
  });
});
