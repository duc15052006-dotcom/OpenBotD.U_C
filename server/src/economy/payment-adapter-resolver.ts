import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentFinancialAccounts, agentProfiles } from "../db/schema";
import type { PaymentCredentialSecretReader } from "../credentials";
import { withPaymentCredentialAdapter } from "./execution";
import { createCircleDeveloperWalletAdapter } from "./circle-adapter";
import type { PaymentAccountAdapter } from "./payment-adapter";

export class PaymentAdapterResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentAdapterResolutionError";
  }
}

export interface PaymentAdapterResolver {
  useForAccount<T>(input: {
    agentId: string;
    accountId: string;
    use: (adapter: PaymentAccountAdapter, provider: string) => Promise<T>;
  }): Promise<T>;
}

function parseCircleBinding(plaintext: string): {
  tokenSymbol: string;
  blockchain: string;
} {
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    throw new PaymentAdapterResolutionError(
      "Circle payment credential is malformed",
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PaymentAdapterResolutionError(
      "Circle payment credential is malformed",
    );
  }
  const value = raw as Record<string, unknown>;
  if (
    typeof value.tokenSymbol !== "string" ||
    !value.tokenSymbol.trim() ||
    typeof value.blockchain !== "string" ||
    !value.blockchain.trim()
  ) {
    throw new PaymentAdapterResolutionError(
      "Circle payment credential binding is incomplete",
    );
  }
  return {
    tokenSymbol: value.tokenSymbol.trim(),
    blockchain: value.blockchain.trim(),
  };
}

export function createPaymentAdapterResolver(input: {
  database: Database;
  encryptionKey: string;
  credentialReader: PaymentCredentialSecretReader;
}): PaymentAdapterResolver {
  return {
    async useForAccount({ agentId, accountId, use }) {
      const normalizedAgentId = agentId.trim();
      const normalizedAccountId = accountId.trim();
      if (!normalizedAgentId || !normalizedAccountId) {
        throw new PaymentAdapterResolutionError(
          "Agent and financial account are required",
        );
      }

      const [account] = await input.database
        .select({
          id: agentFinancialAccounts.id,
          agentId: agentFinancialAccounts.agentId,
          assetCode: agentFinancialAccounts.assetCode,
          provider: agentFinancialAccounts.provider,
          network: agentFinancialAccounts.network,
          credentialId: agentFinancialAccounts.credentialId,
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
            eq(agentFinancialAccounts.id, normalizedAccountId),
            eq(agentFinancialAccounts.agentId, normalizedAgentId),
          ),
        )
        .limit(1);

      if (
        !account?.profileAgentId ||
        !account.assetCode.trim() ||
        !account.provider.trim() ||
        !account.network.trim()
      ) {
        throw new PaymentAdapterResolutionError(
          "financial account is unavailable",
        );
      }

      if (account.provider !== "circle") {
        throw new PaymentAdapterResolutionError(
          "financial account provider is not enabled for live execution",
        );
      }
      if (!account.credentialId) {
        throw new PaymentAdapterResolutionError(
          "financial account has no payment credential",
        );
      }

      return withPaymentCredentialAdapter({
        encryptionKey: input.encryptionKey,
        credentialReader: input.credentialReader,
        credentialId: account.credentialId,
        createAdapter: (plaintext) => {
          const binding = parseCircleBinding(plaintext);
          if (binding.tokenSymbol !== account.assetCode) {
            throw new PaymentAdapterResolutionError(
              "payment credential asset does not match financial account",
            );
          }
          if (binding.blockchain !== account.network) {
            throw new PaymentAdapterResolutionError(
              "payment credential network does not match financial account",
            );
          }
          // Circle adapter defaults fail closed against mainnet. No server config currently opts
          // into mainnet, so this resolver can only construct explicitly testnet-safe adapters.
          return createCircleDeveloperWalletAdapter(plaintext);
        },
        use: (adapter) => use(adapter, account.provider),
      });
    },
  };
}
