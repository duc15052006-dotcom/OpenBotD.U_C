import { describe, expect, test } from "bun:test";
import { credentialKind } from "../src/db/schema/core";
import {
  ECONOMY_WALLET_CREDENTIAL_PROVIDER,
  publicWalletMetadata,
  validateWalletCredentialMetadata,
  walletCredentialKey,
} from "../src/economy/wallet-custody";

describe("Agent Economy wallet custody foundation", () => {
  test("wallet secrets use the existing encrypted credential kind", () => {
    expect(credentialKind.enumValues).toContain("wallet");
    expect(ECONOMY_WALLET_CREDENTIAL_PROVIDER).toBe("agent-economy");
  });

  test("credential keys are isolated by Agent and financial account", () => {
    expect(
      walletCredentialKey({ agentId: "agent-a", accountId: "account-1" }),
    ).toBe("agent:agent-a:financial-account:account-1");
    expect(
      walletCredentialKey({ agentId: "agent-b", accountId: "account-1" }),
    ).not.toBe(
      walletCredentialKey({ agentId: "agent-a", accountId: "account-1" }),
    );
  });

  test("public metadata never carries secret-looking fields through", () => {
    expect(
      publicWalletMetadata({
        address: "0xabc",
        network: "eip155:8453",
        assetCode: "USDC",
        privateKey: "must-not-leak",
        seed: "must-not-leak",
        encryptedValue: "must-not-leak",
      }),
    ).toEqual({
      address: "0xabc",
      network: "eip155:8453",
      assetCode: "USDC",
    });
  });

  test("wallet metadata fails closed when routing identity is incomplete", () => {
    expect(() =>
      validateWalletCredentialMetadata({
        address: "0xabc",
        network: "",
        assetCode: "USDC",
      }),
    ).toThrow("wallet credential metadata needs a network");
  });
});
