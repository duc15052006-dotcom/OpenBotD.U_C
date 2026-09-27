export const ECONOMY_WALLET_CREDENTIAL_PROVIDER = "agent-economy";

export interface WalletCredentialMetadata {
  address: string;
  network: string;
  assetCode: string;
}

export function walletCredentialKey(input: {
  agentId: string;
  accountId: string;
}): string {
  const agentId = input.agentId.trim();
  const accountId = input.accountId.trim();
  if (!agentId || !accountId) {
    throw new Error("agentId and accountId are required");
  }
  return `agent:${agentId}:financial-account:${accountId}`;
}

export function validateWalletCredentialMetadata(
  value: unknown,
): WalletCredentialMetadata {
  if (!value || typeof value !== "object") {
    throw new Error("wallet credential metadata must be an object");
  }

  const record = value as Record<string, unknown>;
  const address =
    typeof record.address === "string" ? record.address.trim() : "";
  const network =
    typeof record.network === "string" ? record.network.trim() : "";
  const assetCode =
    typeof record.assetCode === "string" ? record.assetCode.trim() : "";

  if (!address) throw new Error("wallet credential metadata needs an address");
  if (!network) throw new Error("wallet credential metadata needs a network");
  if (!assetCode) {
    throw new Error("wallet credential metadata needs an asset code");
  }

  return { address, network, assetCode };
}

/**
 * Redacts anything except the intentionally public routing metadata.
 *
 * Callers may pass a credential status object or parsed metadata here, but this helper never accepts
 * or returns encryptedValue/privateKey/seed fields. The actual secret stays behind credentials.ts.
 */
export function publicWalletMetadata(value: unknown): WalletCredentialMetadata {
  return validateWalletCredentialMetadata(value);
}
