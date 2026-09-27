# NOTE — Agent Economy / Revenue & Owner Profit System

Status: **post-release roadmap / architecture note**  
Source baseline: OpenBotD.U_C release-candidate `3528ad9ea55987b6ea9939452807962113cbf1f0`  
Reference study: `Conway-Research/automaton` at `d8f816881fd24b6f5e3d616e59edec387a447667`

This note is intentionally isolated from the current release candidate. Do not merge it into the release branch until the current release gates are complete.

## Objective

Add an **Agent Economy** layer that lets each Bot/Agent:
- keep an independent budget and ledger;
- receive lawful revenue through explicit adapters;
- pay permitted operating costs;
- maintain a minimum reserve;
- calculate real profit rather than treating revenue as profit;
- reinvest an Owner-configured share;
- pay distributable profit to the Owner;
- fund child Agents within policy;
- remain independently accountable while still under Owner control.

The objective is not to make Agents “money-printing machines”. The target lifecycle is:

`create value -> receive revenue -> cover operating cost -> preserve reserve -> reinvest -> distribute legitimate profit`.

## Architectural rule: ledger-first, policy-first

OpenBot must not expose a raw wallet/private key directly to an Agent or plugin.

All financial actions use this boundary:

```
Agent / Revenue Adapter / Routine
              |
              v
       Economy Gateway
              |
        Policy Engine
              |
      Treasury Engine
              |
    Wallet / Payment Adapter
              |
              v
       External Network
```

Every requested financial action is server-authorized, audited, idempotent and fail-closed before any external transfer.

This follows OpenBot's existing architecture where browser/file/MCP acting calls return to the server for policy and audit before execution.

## Conway mechanisms worth adapting

From `Conway-Research/automaton`:

- `TreasuryPolicy` with per-transfer/hour/day caps;
- `minimumReserveCents`;
- confirmation threshold;
- x402 payment cap + domain allowlist;
- inference daily budget;
- transaction records;
- spend tracking over time windows;
- survival tiers that reduce model cost under low funds;
- heartbeat tick context reading balance once per tick;
- durable scheduled tasks;
- creator/owner address concept;
- child lifecycle/funding;
- wallet/config path protection;
- policy decisions persisted for audit;
- x402 top-up mechanics;
- explicit distinction between USDC balance and Conway compute credits.

Do **not** copy Automaton's sovereign-wallet assumption directly. OpenBot has multiple Bots, a human Owner, server-side policy, shared product data and stronger multi-tenant boundaries.

## 1. Per-Agent finance namespace

Each Agent gets a separate finance account:

- `agent_id`
- wallet/account reference
- current settled balance
- pending balance
- gross revenue
- operating cost
- operating profit
- reserve balance
- reinvestment balance
- distributable profit
- lifetime Owner payout
- investment basis
- transaction history
- active budget/policy version

No cross-Agent balance movement without an explicit Owner-approved transfer/funding rule.

## 2. Asset classification

Never collapse different value types into one “balance”.

Required classes:

- `FIAT`
- `STABLECOIN`
- `CRYPTO_OTHER` (disabled by default)
- `COMPUTE_CREDIT`
- `INTERNAL_CREDIT`
- `RECEIVABLE`
- `PAYABLE`

Conway credits and other non-redeemable compute credits must not be shown as withdrawable cash, revenue or Owner profit.

Every balance row includes:
- asset code;
- asset class;
- network/provider;
- redeemable boolean;
- valuation source;
- valuation timestamp.

## 3. Treasury Engine

Priority order:

```
Revenue
  -> Operating Costs
  -> Minimum Reserve
  -> Reinvestment
  -> Distributable Profit
  -> Owner Payout
```

Invariant:

`Survive -> Reserve -> Reinvest -> Profit -> Owner`

No payout may reduce settled funds below the minimum reserve or violate pending obligations.

## 4. Profit Engine

```
Gross Revenue
- AI Inference Cost
- VM / Computer Cost
- API Cost
- Domain Cost
- Tool Cost
- Transaction Fees
- Other Operating Cost
= Operating Profit

Operating Profit
- Reserve Allocation
- Reinvestment
= Distributable Profit
```

Only **Distributable Profit** can be paid to the Owner.

Revenue events, cost events and transfers must be ledger entries, not mutable summary counters. Dashboard summaries are derived from ledger entries.

## 5. Owner-controlled allocation

Config example:

```json
{
  "ownerShare": 0.5,
  "reinvestmentShare": 0.3,
  "reserveShare": 0.2
}
```

Rules:
- shares must be Owner-configured;
- Agent cannot modify them without a specific grant;
- version every policy change;
- historical P&L must continue using the policy version active at the time.

## 6. Minimum Reserve and financial health

Each Agent has `minimumReserve`.

Suggested finance states:

- `HEALTHY`
- `LOW_RESERVE`
- `CRITICAL`
- `PROFITABLE`
- `PAYOUT_READY`
- `FROZEN`
- `INSOLVENT`

When reserve is low:
- block payouts;
- stop optional purchases;
- reduce inference/model cost where policy permits;
- limit child creation/funding;
- prioritize revenue-producing work;
- notify Owner.

Financial state is separate from runtime state.

## 7. Payout Engine

Modes:
- manual;
- automatic;
- scheduled;
- threshold.

Core condition:

```
available_profit >= payout_threshold
AND balance_after_payout >= minimum_reserve
AND no_financial_lock
AND destination_is_owner_whitelist
AND spend_policy_allows
```

Then and only then may `send_owner_payout()` execute.

Scheduled/threshold payouts should use OpenBot's durable `work_items`/routine-style scheduling rather than process-local timers.

## 8. Owner wallet

Support `OWNER_WALLET` initially, then multiple Owners/team allocation later.

Security requirements:
- wallet destination stored as protected server credential/config;
- Agent cannot mutate it directly;
- private keys never enter model context;
- private keys never enter plugin/MCP payloads;
- only whitelisted payout destinations;
- rotation requires Owner/admin authorization and audit.

## 9. Revenue Adapter interface

Economy is accounting and policy; revenue generation remains pluggable.

```
RevenueAdapter
  |- SaaSAdapter
  |- ApiAdapter
  |- MarketplaceAdapter
  |- X402Adapter
  |- ServicesAdapter
  |- CustomAdapter
```

Candidate lawful sources:
- SaaS;
- paid APIs;
- AI services;
- coding/research/data/content/automation services;
- digital products;
- marketplaces;
- agent-to-agent services;
- x402-compatible services.

Each adapter must provide normalized revenue events and reconciliation evidence. An adapter must never get raw wallet keys.

## 10. Agent Wallet abstraction

Do not bind Treasury to one chain or wallet implementation.

Proposed interface:

```ts
interface PaymentAccountAdapter {
  getBalance(asset: AssetRef): Promise<Money>;
  listTransactions(cursor?: string): Promise<TransactionPage>;
  prepareTransfer(request: TransferRequest): Promise<PreparedTransfer>;
  executeTransfer(prepared: PreparedTransfer): Promise<TransferReceipt>;
  verifyTransfer(receipt: TransferReceipt): Promise<VerifiedTransfer>;
}
```

Initial implementations can include:
- custodial/provider account;
- EVM USDC wallet;
- x402 payment adapter;
- mock/local test adapter.

Key custody must be isolated from Agent/Computer/plugin runtimes.

## 11. Financial Permission System

Per-Agent policy:

- `max_payment_per_transaction`
- `max_hourly_spend`
- `max_daily_spend`
- `max_monthly_spend`
- `minimum_reserve`
- `owner_confirmation_threshold`
- `allowed_payment_addresses`
- `allowed_payment_categories`
- `allowed_assets`
- `allowed_networks`
- `allowed_revenue_adapters`
- `max_child_funding`
- `max_x402_payment`
- `x402_allowed_domains`

Suggested decision pattern:
- small transaction -> policy may auto-approve;
- medium transaction -> policy approval;
- large transaction -> explicit Owner confirmation.

Exact thresholds remain Owner-configurable.

## 12. Financial Kill Switch

Owner action: **FREEZE ALL FINANCIAL ACTIVITY**.

When active:
- no transfer;
- no purchase;
- no payout;
- no child funding;
- no new financial transaction.

Local/offline work may continue if it requires no financial action.

Kill switch must be checked server-side immediately before external execution, not only when the Agent plans the action.

## 13. Immutable financial audit

Every event records at least:

- timestamp;
- agent_id;
- transaction_id;
- idempotency_key;
- type;
- source;
- destination;
- amount;
- currency/asset;
- purpose;
- tool/adapter;
- approval actor + policy;
- balance_before;
- balance_after;
- status;
- external reference/hash;
- failure/refusal reason;
- initiator kind/id;
- policy version.

Agent cannot delete/update historical audit rows. Corrections use compensating entries.

## 14. Suggested PostgreSQL model

Minimum tables:

- `agent_financial_accounts`
- `agent_ledger_entries`
- `agent_financial_policies`
- `agent_financial_locks`
- `agent_payout_rules`
- `agent_payouts`
- `agent_investments`
- `revenue_adapters`
- `revenue_events`
- `cost_events`
- `payment_intents`
- `payment_receipts`
- `agent_funding_relationships`

Use decimal/integer minor units; never floating-point money.

## 15. Cost attribution

OpenBot must attribute costs to Agent/project/adapter where possible:

- model inference;
- Computer/VM runtime;
- API/tool;
- domain;
- transaction fee;
- plugin;
- marketplace;
- external service.

Unknown cost is reported as unallocated cost, not silently treated as zero.

## 16. P&L and ROI

P&L periods:
- daily;
- weekly;
- monthly;
- lifetime.

ROI:

`ROI = (Net Profit / Total Investment) * 100`

Dimensions:
- Agent;
- project;
- Revenue Adapter;
- entire OpenBot deployment.

If investment basis is zero/unknown, ROI must be `N/A`, not infinity or fabricated.

## 17. Multi-Agent economy

Parent Agent may request child funding through Treasury.

Each funding relationship tracks:
- parent_agent_id;
- child_agent_id;
- budget;
- spent;
- revenue;
- profit;
- ROI;
- active/frozen state.

Parent Agent can recommend stopping funding; actual stop/limits still go through Owner policy.

No child inherits unrestricted wallet authority from its parent.

## 18. Heartbeat / survival integration

Adapt Automaton's idea without tying OpenBot runtime identity to money.

A finance heartbeat can:
- refresh settled balances;
- reconcile incoming revenue;
- reconcile pending transfers;
- recompute reserve state;
- schedule payout eligibility checks;
- emit Owner alerts;
- lower optional spend/model tier in low reserve;
- stop optional child funding.

Use durable work scheduling; never rely only on an in-memory timer.

## 19. x402

x402 support should be an adapter, not a privileged core assumption.

Requirements:
- domain allowlist;
- per-payment cap;
- daily cap;
- policy check;
- minimum reserve check;
- idempotency;
- transaction logging;
- receipt verification;
- separate compute credits from cash-equivalent USDC.

## 20. Safety invariants

Agent must never be able to:
- drain full balance;
- bypass spend limits;
- mutate Owner payout address;
- reveal wallet private key/seed;
- borrow or create debt without Owner enablement;
- trade speculative/risky assets without explicit capability;
- hide/delete ledger entries;
- misuse customer funds;
- use illegal revenue sources;
- self-approve above confirmation threshold;
- alter the financial kill switch;
- treat pending/unsettled funds as distributable profit.

## 21. Dashboard

New **Agent Economy** area:

Per Agent and aggregate:
- Revenue Today;
- Revenue This Month;
- Operating Cost;
- AI Cost;
- VM Cost;
- Net Profit;
- Reserve;
- Reinvestment;
- Distributable Profit;
- Owner Payout;
- ROI;
- Wallet Balance;
- finance state;
- pending approvals;
- recent transactions/refusals.

Never label non-redeemable credits as withdrawable cash.

## 22. OpenBot integration points

Use existing OpenBot boundaries:

- `server`: Economy Gateway, Treasury, policy, ledger, adapters, payout orchestration;
- PostgreSQL: ledger + policy + audit source of truth;
- existing policy engine: financial fields/rules and deny-first fail-closed behavior;
- existing audit trail: financial decisions and execution outcomes;
- existing signed run initiator metadata: person/routine/handoff attribution;
- `work_items` / routines: scheduled payout, reconciliation, finance heartbeat;
- app/admin UI: Agent Economy dashboard and approvals;
- Computer/Bot runtimes: request financial intents only, never hold signing keys.

## 23. Proposed implementation sequence

### Phase E0 — schema + accounting foundation
- asset model;
- ledger;
- P&L projection;
- policy schema;
- immutable audit;
- no real money movement.

### Phase E1 — cost accounting
- inference cost;
- VM/computer cost;
- tool/API cost adapters;
- dashboard read-only P&L/ROI.

### Phase E2 — payment intent + mock wallet
- Economy Gateway;
- limits;
- reserve checks;
- owner confirmations;
- kill switch;
- deterministic/idempotent test adapter.

### Phase E3 — real payment adapter
- one stablecoin/payment provider;
- protected key custody;
- verified receipts;
- whitelists;
- real incoming/outgoing reconciliation.

### Phase E4 — revenue adapters
- API/SaaS/marketplace/x402/custom adapter framework;
- normalized revenue events.

### Phase E5 — owner payout
- manual payout first;
- then threshold/scheduled automation;
- distributable-profit proof before transfer.

### Phase E6 — child economy
- parent funding;
- per-child budgets;
- child ROI;
- funding freeze.

### Phase E7 — adaptive survival controls
- low-reserve model downgrade;
- optional spend suppression;
- Owner alerts;
- finance heartbeat.

## 24. Release rule

This roadmap is **not part of the current release candidate**.

Do not add real-money execution to the current release as a late-stage change.

Implementation starts from a clean post-release branch with migrations/tests designed before enabling any external transfer path.
