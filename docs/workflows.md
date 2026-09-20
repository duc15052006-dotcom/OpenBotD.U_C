# Durable workflows

A workflow is a durable multi-step plan owned by one person and one Bot. It is the state layer used
for work that cannot safely live in one model turn: content pipelines, long-running generation,
review chains, or plans that sleep and resume later.

This layer deliberately reuses the deployment's existing scheduler and `work_items` queue. It does
not create a second lease, timer, or coordinator.

## Agent tools

The durable store is exposed through the first-party **Workflows** plugin, not as an ungoverned
internal shortcut. An administrator must enable the Workflows catalogue entry and grant its tools to
a Bot before that Bot can create or mutate workflow state. Calls derive the owner and Bot from the
active run connection; tool arguments cannot substitute another owner or Agent id.

The tool surface can create/list/read workflows, pause/resume/cancel them, start/wait/complete/fail
or retry steps, and add/list/remove per-step asset metadata. Waiting a step persists an exact future
timestamp and lets the shared durable wake bridge resume it later instead of keeping a browser turn
alive or polling in a loop.

This surface changes workflow state only. It does not grant Browser, Files, Computer, connector or
host access; execution of a step still uses the Bot's existing grants and policy at the time the
action is attempted.

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
part of the check failed. The create tool may omit `channelId`: when the owner and Bot share exactly
one live channel the store resolves it server-side; when they share several, creation is refused with
the available channel choices so the Agent can ask the person instead of inventing an opaque id.

Deleting an Agent cascades its workflow rows and steps, so a pending plan cannot survive as stale work
for an identity that no longer exists.

## Dependencies and retries

Root steps begin `ready`; dependent steps begin `blocked`. Ready steps are discovered by a bounded
recovery sweep and offered to the existing durable `work_items` queue. The queued identity includes
the exact ready timestamp and current attempt count; starting is a compare-and-set from that exact
`ready` version to `running` and increments the durable attempt count.

The same exact queue item may be retried after a worker/model interruption. A dispatch stamp on the
running attempt lets only that item re-enter the same attempt; a manual start, a newer retry, or any
other state transition makes the old item stale. Long headless turns renew their queue lease while
they run so a second replica cannot claim the same autonomous step mid-turn.

Completing a step promotes only blocked steps whose complete dependency set has succeeded. Workflow
transitions are serialized with a PostgreSQL transaction-scoped advisory lock, so two steps finishing
at the same time cannot leave a dependent step permanently blocked.

A running step may fail without destroying the workflow. It becomes `failed`, keeps its attempt
history and failure reason, and can be moved back to `ready` only when all of its dependencies still
succeeded. The retry transition mints a fresh monotonic ready stamp so an older finished queue item
cannot suppress the new attempt. The next start increments the same attempt counter.

When a ready-step queue item has already started its exact attempt but autonomous dispatch keeps
failing until the queue retry budget is exhausted, that exact running attempt is failed with a
visible retry-budget reason instead of being left permanently `running`.

## Autonomous step execution

Creating a workflow no longer requires a person or Agent turn to manually start each root or newly
unblocked step. Every active `ready` step is offered idempotently to the shared durable queue and
runs through the same governed headless Agent path used for resumed waits. The Agent receives the
workflow id, step key, durable attempt number and stored instruction, then must checkpoint the step
before its turn ends: complete it, put it into a future wait, or fail it with a concrete reason.

This is execution orchestration, not a permission shortcut. The headless turn rebuilds the Agent for
the workflow owner and Bot, uses the workflow's existing channel/thread, and receives only the tools
and permissions that Agent currently has. Browser, Files, Computer and connector policy remain
unchanged.

Completing one step can promote dependent steps to `ready`; those new ready versions are then picked
up by the same durable bridge. This is what lets a multi-step DAG continue autonomously instead of
stopping after each dependency boundary.

### Autonomous concurrency limits

Before an autonomous ready step starts or a due wait resumes, the workflow store applies cluster-wide admission control under a PostgreSQL transaction advisory lock. At most **20** autonomous workflow steps may be `running` across one deployment, and at most **4** may be `running` for one Bot.

This is an admission ceiling rather than a queue batch size, so multiple replicas cannot race past it. If capacity is full, the exact claimed work item is deferred with backoff and its claim attempt is rolled back; healthy work therefore does not exhaust its retry budget merely because the deployment stayed busy. The workflow step remains `ready` or `waiting` and can be admitted later.

### Exhausted-attempt crash recovery

Normal queue execution stops after its bounded retry budget. A separate cleanup lane leases exhausted workflow work without incrementing its attempt count. This closes the crash window where a worker can die on its final dispatch after the durable step has already moved to `running`: the normal claim lane will not run the side effect again, while cleanup reconciles only the exact persisted ready/wait dispatch stamp and attempt.

Cleanup can fail an exact still-`ready`, still-`waiting`, or exact autonomous `running` state. A stale queue item cannot fail a newer state, including a later wait/resume cycle that kept the same workflow attempt number, because the exact dispatch timestamp must still match. Transient cleanup failures are released for another cleanup pass; stale items are finished harmlessly.

## Durable waits

A running step can enter `waiting` with an exact future timestamp and an optional provider label.
The provider field is metadata only and must never contain a credential.

Both future-wait validation and due-wait discovery use PostgreSQL's clock. A skewed app/server clock
therefore cannot reject a database-future wake or accept one the database already considers due.
Resuming a wait compares the exact persisted timestamp as well as the step status. A stale wake therefore cannot resume a step whose wait was cancelled or
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

Pause and resume keep the workflow's steps, attempts and provider state durable. A paused workflow
cannot start or resume work. On Resume, any still-ready step receives a fresh monotonic ready stamp,
and any overdue waiting step receives a fresh exact wake timestamp. That re-arms work whose old
deterministic queue item may have been finished while the workflow was paused, without replaying a
newer or manually-started attempt.

Cancel marks the run terminal and cancels every still-blocked, ready, running or waiting step in one
serialized transaction. Completed or previously failed steps remain as evidence of what happened.

## Workflow dashboard

The signed-in person can inspect their own durable workflows at \`/workflows\`. The dashboard shows
workflow status, the coworker carrying it out, durable step state, attempts, provider/wait metadata,
failure reasons and the per-step asset ledger. It can pause, resume or cancel a non-terminal
workflow; creation and structural editing stay conversational through the Agent so there is still one
orchestration path rather than a second browser-side workflow builder.

The browser never supplies an owner id or Bot id for dashboard reads or controls. The API derives the
owner from the authenticated session, resolves the workflow by that owner, and then uses the Bot id
persisted on the workflow for mutations and asset reads. A workflow belonging to another person is
therefore indistinguishable from one that does not exist.

## Security invariants

Workflow state never stores API keys, browser passwords or host credentials. It does not widen Browser,
Files, Computer or plugin grants. When execution wiring calls a provider later, the Agent still acts
through its existing per-person/per-Bot permission and credential paths.

The database state is a recovery ledger, not an authorization bypass: a persisted task is not evidence
that the action it describes is currently allowed.
