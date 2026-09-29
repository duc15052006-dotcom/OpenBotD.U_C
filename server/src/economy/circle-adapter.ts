import { constants, createHash, publicEncrypt } from "node:crypto";
import type {
  Money,
  PaymentAccountAdapter,
  PreparedTransfer,
  TransferReceipt,
  TransferRequest,
} from "./payment-adapter";

const CIRCLE_BASE_URL = "https://api.circle.com/v1/w3s";

type FetchLike = typeof fetch;

export interface CirclePaymentCredential {
  apiKey: string;
  entitySecretHex: string;
  walletId: string;
  tokenId: string;
  tokenSymbol: string;
  tokenDecimals: number;
  blockchain: string;
}

export interface CircleAdapterOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  allowMainnet?: boolean;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type CircleTransaction = {
  id: string;
  state: string;
  txHash?: string;
  walletId?: string;
  tokenId?: string;
  destinationAddress?: string;
  amounts?: string[];
};

const terminalFailureStates = new Set(["FAILED", "DENIED", "CANCELLED"]);

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function testnetBlockchain(blockchain: string): boolean {
  return (
    blockchain === "EVM-TESTNET" ||
    /-(SEPOLIA|AMOY|FUJI|DEVNET|TESTNET)$/.test(blockchain)
  );
}

function parseCredential(plaintext: string): CirclePaymentCredential {
  let value: unknown;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw new Error("Circle payment credential must be valid JSON");
  }

  if (!value || typeof value !== "object") {
    throw new Error("Circle payment credential must be an object");
  }

  const candidate = value as Partial<CirclePaymentCredential>;
  for (const field of [
    "apiKey",
    "entitySecretHex",
    "walletId",
    "tokenId",
    "tokenSymbol",
    "blockchain",
  ] as const) {
    if (!candidate[field]?.trim()) {
      throw new Error(`Circle payment credential is missing ${field}`);
    }
  }

  const entitySecretHex = candidate.entitySecretHex;
  if (
    typeof entitySecretHex !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(entitySecretHex)
  ) {
    throw new Error("Circle entity secret must be a 32-byte hexadecimal value");
  }

  const tokenDecimals = candidate.tokenDecimals;
  if (
    typeof tokenDecimals !== "number" ||
    !Number.isInteger(tokenDecimals) ||
    tokenDecimals < 0 ||
    tokenDecimals > 30
  ) {
    throw new Error("Circle token decimals must be an integer from 0 to 30");
  }

  return candidate as CirclePaymentCredential;
}

function decimalToMinor(value: string, decimals: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error("Circle returned an invalid token amount");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) {
    throw new Error("Circle token amount exceeds configured precision");
  }
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(
      (fraction.slice(0, decimals) + "0".repeat(decimals)).slice(0, decimals) ||
        "0",
    )
  );
}

function minorToDecimal(value: bigint, decimals: number): string {
  if (value <= 0n) throw new Error("Circle transfer amount must be positive");
  if (decimals === 0) return value.toString();

  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
}

function requireMatchingCompleteTransaction(
  transaction: CircleTransaction,
  credential: CirclePaymentCredential,
  prepared: PreparedTransfer,
): void {
  if (transaction.walletId !== credential.walletId) {
    throw new Error(
      "Circle completed transaction wallet does not match configured account",
    );
  }
  if (transaction.tokenId !== credential.tokenId) {
    throw new Error(
      "Circle completed transaction token does not match configured asset",
    );
  }
  if (transaction.destinationAddress !== prepared.request.destination) {
    throw new Error(
      "Circle completed transaction destination does not match prepared transfer",
    );
  }
  if (transaction.amounts?.length !== 1) {
    throw new Error("Circle completed transaction amount evidence is missing");
  }
  const providerAmountMinor = decimalToMinor(
    transaction.amounts[0] ?? "",
    credential.tokenDecimals,
  );
  if (providerAmountMinor !== prepared.request.amount.amountMinor) {
    throw new Error(
      "Circle completed transaction amount does not match prepared transfer",
    );
  }
}

function circleIdempotencyKey(value: string): string {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    return value.toLowerCase();
  }

  // Circle requires UUID v4. OpenBot idempotency keys are intentionally provider-neutral strings,
  // so map them deterministically rather than generating a fresh UUID on retry.
  const bytes = new Uint8Array(
    createHash("sha256").update(value).digest().subarray(0, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function jsonResponse<T>(
  response: Response,
  operation: string,
): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Circle ${operation} returned a non-JSON response`);
  }
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;
    throw new Error(`Circle ${operation} failed: ${message}`);
  }
  return body as T;
}

function transactionFrom(body: unknown): CircleTransaction {
  if (!body || typeof body !== "object" || !("data" in body)) {
    throw new Error("Circle transaction response is malformed");
  }
  const data = (body as { data?: unknown }).data;
  const transaction =
    data &&
    typeof data === "object" &&
    "transaction" in data &&
    (data as { transaction?: unknown }).transaction
      ? (data as { transaction: unknown }).transaction
      : data;

  if (
    !transaction ||
    typeof transaction !== "object" ||
    typeof (transaction as { id?: unknown }).id !== "string" ||
    typeof (transaction as { state?: unknown }).state !== "string"
  ) {
    throw new Error("Circle transaction response is malformed");
  }
  return transaction as CircleTransaction;
}

export class CircleDeveloperWalletAdapter implements PaymentAccountAdapter {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;
  private publicKey?: string;

  constructor(
    private readonly credential: CirclePaymentCredential,
    options: CircleAdapterOptions = {},
  ) {
    if (!options.allowMainnet && !testnetBlockchain(credential.blockchain)) {
      throw new Error(
        "Circle mainnet is disabled; explicitly enable it at the server boundary",
      );
    }
    this.fetch = options.fetch ?? fetch;
    this.baseUrl = trimSlash(options.baseUrl ?? CIRCLE_BASE_URL);
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.maxPollAttempts = options.maxPollAttempts ?? 60;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.credential.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async entityPublicKey(): Promise<string> {
    if (this.publicKey) return this.publicKey;
    const response = await this.fetch(
      `${this.baseUrl}/config/entity/publicKey`,
      { headers: this.headers() },
    );
    const body = await jsonResponse<{ data?: { publicKey?: string } }>(
      response,
      "public-key request",
    );
    const key = body.data?.publicKey;
    if (!key) throw new Error("Circle public-key response is malformed");
    this.publicKey = key;
    return key;
  }

  private async entitySecretCiphertext(): Promise<string> {
    const ciphertext = publicEncrypt(
      {
        key: await this.entityPublicKey(),
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(this.credential.entitySecretHex, "hex"),
    );
    return ciphertext.toString("base64");
  }

  async getBalance(assetCode: string): Promise<Money> {
    if (assetCode !== this.credential.tokenSymbol) {
      throw new Error("Circle adapter only exposes its configured token");
    }
    const response = await this.fetch(
      `${this.baseUrl}/wallets/${encodeURIComponent(this.credential.walletId)}/balances?includeAll=true`,
      { headers: this.headers() },
    );
    const body = await jsonResponse<{
      data?: {
        tokenBalances?: Array<{
          amount?: string;
          token?: { id?: string; symbol?: string; decimals?: number };
        }>;
      };
    }>(response, "balance request");
    const balance = body.data?.tokenBalances?.find(
      (candidate) => candidate.token?.id === this.credential.tokenId,
    );
    if (!balance?.amount) {
      return { assetCode, amountMinor: 0n };
    }

    if (
      balance.token?.symbol !== this.credential.tokenSymbol ||
      balance.token?.decimals !== this.credential.tokenDecimals
    ) {
      throw new Error(
        "Circle token metadata does not match configured account",
      );
    }
    return {
      assetCode,
      amountMinor: decimalToMinor(
        balance.amount,
        this.credential.tokenDecimals,
      ),
    };
  }

  async prepareTransfer(request: TransferRequest): Promise<PreparedTransfer> {
    if (request.amount.assetCode !== this.credential.tokenSymbol) {
      throw new Error("Circle transfer asset does not match configured token");
    }
    if (!request.destination.trim()) {
      throw new Error("Circle transfer destination is required");
    }
    if (request.amount.amountMinor <= 0n) {
      throw new Error("Circle transfer amount must be positive");
    }
    return {
      id: `circle:${circleIdempotencyKey(request.idempotencyKey)}`,
      request,
    };
  }

  async executeTransfer(prepared: PreparedTransfer): Promise<TransferReceipt> {
    const idempotencyKey = prepared.id.replace(/^circle:/, "");
    if (!prepared.id.startsWith("circle:")) {
      throw new Error("Circle transfer was not prepared by this adapter");
    }

    const response = await this.fetch(
      `${this.baseUrl}/developer/transactions/transfer`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          idempotencyKey,
          entitySecretCiphertext: await this.entitySecretCiphertext(),
          walletId: this.credential.walletId,
          tokenId: this.credential.tokenId,
          destinationAddress: prepared.request.destination,
          amounts: [
            minorToDecimal(
              prepared.request.amount.amountMinor,
              this.credential.tokenDecimals,
            ),
          ],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        }),
      },
    );
    const created = transactionFrom(
      await jsonResponse<unknown>(response, "transfer request"),
    );

    for (let attempt = 0; attempt < this.maxPollAttempts; attempt += 1) {
      const transaction =
        attempt === 0 ? created : await this.getTransaction(created.id);

      if (transaction.state === "COMPLETE") {
        requireMatchingCompleteTransaction(
          transaction,
          this.credential,
          prepared,
        );
        return {
          // Persist Circle's immutable transaction id rather than the chain hash. The transaction id
          // is the provider lookup key required for later reconciliation; the chain hash remains
          // provider evidence returned by the lookup itself.
          transferId: transaction.id,
          idempotencyKey: prepared.request.idempotencyKey,
          amount: prepared.request.amount,
          destination: prepared.request.destination,
        };
      }
      if (terminalFailureStates.has(transaction.state)) {
        throw new Error(
          `Circle transfer reached terminal state ${transaction.state}`,
        );
      }
      if (transaction.state === "STUCK") {
        throw new Error(
          "Circle transfer is stuck and requires explicit operator recovery",
        );
      }
      if (attempt + 1 < this.maxPollAttempts) {
        await this.sleep(this.pollIntervalMs);
      }
    }

    throw new Error("Circle transfer verification timed out before finality");
  }

  private async getTransaction(id: string): Promise<CircleTransaction> {
    const response = await this.fetch(
      `${this.baseUrl}/transactions/${encodeURIComponent(id)}`,
      { headers: this.headers() },
    );
    return transactionFrom(
      await jsonResponse<unknown>(response, "transaction lookup"),
    );
  }

  async verifyTransfer(receipt: TransferReceipt): Promise<boolean> {
    if (!receipt.transferId.trim()) return false;
    if (receipt.amount.assetCode !== this.credential.tokenSymbol) return false;
    if (receipt.amount.amountMinor <= 0n || !receipt.destination.trim()) {
      return false;
    }

    const transaction = await this.getTransaction(receipt.transferId);
    if (transaction.state !== "COMPLETE") return false;

    try {
      requireMatchingCompleteTransaction(transaction, this.credential, {
        id: `circle:${receipt.idempotencyKey}`,
        request: {
          idempotencyKey: receipt.idempotencyKey,
          amount: receipt.amount,
          destination: receipt.destination,
        },
      });
    } catch {
      return false;
    }
    return true;
  }
}

export function createCircleDeveloperWalletAdapter(
  plaintextCredential: string,
  options: CircleAdapterOptions = {},
): CircleDeveloperWalletAdapter {
  return new CircleDeveloperWalletAdapter(
    parseCredential(plaintextCredential),
    options,
  );
}
