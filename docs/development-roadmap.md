# OpenBotD.U_C development roadmap

This fork keeps the upstream OpenBot architecture intact where possible and adds product-level agent customization in small, reviewable increments.

## Baseline principles

- Do not develop directly on `main`.
- Reuse upstream agent, computer, handoff, credential, policy, and release primitives instead of duplicating them.
- Keep host files and browser profiles outside agent containers by default.
- Store secrets through the existing encrypted credential path; never persist raw API keys in agent profile data.
- Prefer small feature branches with typecheck, lint, tests, build, and diff review before merge.
- Preserve upstream compatibility unless a product requirement makes a deliberate divergence necessary.

## Delivery order

1. Agent card actions and settings entry points.
2. Per-agent provider/model/credential configuration.
3. Skills and knowledge management.
4. Per-agent computer lifecycle and resource settings.
5. Isolated file browsing and explicit export.
6. Team/group data model and multi-agent chat UX.
7. Delegation/task visibility on top of the existing handoff runtime.
8. Permission hardening and audit UX.
9. Windows onboarding, diagnostics, packaging, and release validation.

## Definition of done for a feature increment

A feature is not considered complete because its UI renders. The increment must have a coherent data path, permission behavior, failure states, and appropriate automated or CI validation. Any schema change must include a safe migration path and preserve existing installations where practical.
