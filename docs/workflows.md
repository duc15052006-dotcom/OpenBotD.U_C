# Durable workflows

A workflow is a durable multi-step plan owned by one person and one Bot. It is the state layer used
for work that cannot safely live in one model turn: content pipelines, long-running generation,
review chains, or plans that sleep and resume later.

This layer deliberately reuses the deployment's existing scheduler and `work_items` queue. It does
not create a second lease, timer, or coordinator.

## State model

A workflow run records its owner, Bot, destination channel, title and lifecycle:

- `active` — new steps may start and due waits may resume;
- `paused` — state remains durable but no new step starts;
- `succeeded` — every step completed;
- `failed` — the workflow was explicitly abandoned as failed;
- `cancelled` — the owner/Bot cancelled the remaining work.

Each step records a stable local key, position, instruction, dependency keys, status, attempt count,
optional provider, optional exact wait timestamp, failure reason and lifecycle timestamps.

Dependencies may point only to earlier steps supplied in the same create operation. That rule makes
the graph acyclic by construction and prevents a step from naming another workflow's state.

## Isolation

Every person-facing transition is filtered by both `owner_user_id` and `agent_id`. Two Bots owned
by the same person therefore cannot read, pause, resume, cancel or mutate each other's workflow just
because they share an owner.

The destination channel is accepted only when the owner is a member and the Bot is in that same
non-deleted channel. A missing, foreign or deleted channel is one refusal and does not reveal which
part of the check failed.

Deleting an Agent cascades its workflow rows and steps, so a pending plan cannot survive as stale work
for an identity that no longer exists.

## Dependencies and retries

Root steps begin `ready`; dependent steps begin `blocked`. Starting a step is a compare-and-set from
`ready` to `running` and increments its durable attempt count.

Completing a step promotes only blocked steps whose complete dependency set has succeeded. Workflow
transitions are serialized with a PostgreSQL transaction-scoped advisory lock, so two steps finishing
at the same time cannot leave a dependent step permanently blocked.

A running step may fail without destroying the workflow. It becomes `failed`, keeps its attempt
history and failure reason, and can be moved back to `ready` only when all of its dependencies still
succeeded. The next start increments the same attempt counter.

## Durable waits

A running step can enter `waiting` with an exact future timestamp and an optional provider label.
The provider field is metadata only and must never contain a credential.

Due-wait discovery uses PostgreSQL's clock. Resuming a wait compares the exact persisted timestamp as
well as the step status. A stale wake therefore cannot resume a step whose wait was cancelled or
rescheduled after that wake was created.

Due workflow waits are bridged into the existing `work_items` queue. The queue remains the single
durable execution mechanism: it owns claims, leases, retries and idempotency, while the workflow store
owns state transitions. Each queued wake names the exact persisted wait timestamp; if a wait is
cancelled or rescheduled before delivery, the old item cannot resume the step and is finished as stale.

The bridge uses a bounded periodic recovery sweep rather than busy-waiting on an external website.
Agents can sleep while external generation is pending, and a server/app restart simply leaves the
persisted wait to be discovered and resumed later.

## Step assets

Each workflow step can keep a durable metadata ledger of its inputs and outputs. Entries record whether
the asset is an input or output, its media kind, an optional label, and a bounded reference. This is
useful for scene-by-scene content pipelines where prompts, reference images, renders, audio and final
outputs must remain attached to the exact task that produced or consumed them.

The ledger does not grant file access. It accepts only `attachment:<uuid>` references that are visible
in the workflow's exact channel, or `workspace:<relative-path>` references with no absolute or dot
segments. Reading/writing the underlying bytes still goes through the existing Attachment, Files,
Computer and policy boundaries. Assets therefore cannot be used to smuggle another Bot's state or a
host filesystem path into a workflow.

## Pause, resume and cancel

Pause and resume change only the workflow gate; they do not erase steps, attempts, provider state or
wait timestamps. A paused workflow cannot start or resume work.

Cancel marks the run terminal and cancels every still-blocked, ready, running or waiting step in one
serialized transaction. Completed or previously failed steps remain as evidence of what happened.

## Security invariants

Workflow state never stores API keys, browser passwords or host credentials. It does not widen Browser,
Files, Computer or plugin grants. When execution wiring calls a provider later, the Agent still acts
through its existing per-person/per-Bot permission and credential paths.

The database state is a recovery ledger, not an authorization bypass: a persisted task is not evidence
that the action it describes is currently allowed.
