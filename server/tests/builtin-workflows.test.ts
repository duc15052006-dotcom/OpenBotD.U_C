import { afterEach, describe, expect, test } from "bun:test";
import {
  callTool,
  listTools,
  type WorkflowTools,
  useWorkflowTools,
} from "../src/plugins/builtin-workflows";

const CONNECTION = {
  url: "builtin://workflows",
  actorId: "user_owner",
  botId: "bot_worker",
};

const now = new Date("2026-09-19T12:00:00.000Z");
const step = {
  id: "workflow_step_1",
  workflowId: "workflow_1",
  key: "render",
  position: 0,
  instruction: "Render scene one.",
  dependsOn: [] as string[],
  status: "ready" as const,
  attempts: 0,
  provider: null,
  waitUntil: null,
  failureReason: null,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
};
const plan = {
  id: "workflow_1",
  ownerUserId: "user_owner",
  agentId: "bot_worker",
  channelId: "channel_1",
  title: "Video pipeline",
  status: "active" as const,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
  steps: [step],
};

afterEach(() => useWorkflowTools(null));

describe("workflow tool catalogue", () => {
  test("lists the durable workflow controls", async () => {
    const names = (await listTools()).map((tool) => tool.name);
    expect(names).toContain("create_workflow");
    expect(names).toContain("wait_workflow_step");
    expect(names).toContain("add_workflow_asset");
    expect(names).toContain("cancel_workflow");
  });
});

describe("workflow identity boundary", () => {
  test("create derives owner and Bot from the connection", async () => {
    let received: Parameters<WorkflowTools["create"]>[0] | undefined;
    useWorkflowTools({
      async create(input) {
        received = input;
        return plan;
      },
      async get() { return plan; },
      async listFor() { return [plan]; },
      async pause() { return plan; },
      async resume() { return plan; },
      async cancel() { return plan; },
      async startStep() { return step; },
      async waitStep() { return { ...step, status: "waiting" as const }; },
      async completeStep() { return plan; },
      async failStep() { return { ...step, status: "failed" as const }; },
      async retryStep() { return step; },
      async addAsset() {
        return {
          id: "asset_1",
          workflowId: plan.id,
          stepKey: "render",
          direction: "input",
          mediaKind: "image",
          ref: "workspace:scene/reference.png",
          label: null,
          createdAt: now,
        };
      },
      async listAssets() { return []; },
      async removeAsset() {},
    });

    const result = await callTool(CONNECTION, "create_workflow", {
      ownerUserId: "user_attacker",
      agentId: "bot_attacker",
      channelId: "channel_1",
      title: "Video pipeline",
      steps: [{ key: "render", instruction: "Render scene one." }],
    });

    expect(result.isError).toBe(false);
    expect(received).toMatchObject({
      ownerUserId: "user_owner",
      agentId: "bot_worker",
      channelId: "channel_1",
      title: "Video pipeline",
    });
  });

  test("refuses calls without connection identity", async () => {
    useWorkflowTools({} as WorkflowTools);
    const result = await callTool(
      { url: "builtin://workflows" },
      "list_workflows",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("attributed");
  });
});

describe("workflow wait input", () => {
  test("refuses a local timestamp with no explicit offset", async () => {
    useWorkflowTools({} as WorkflowTools);
    const result = await callTool(CONNECTION, "wait_workflow_step", {
      id: "workflow_1",
      stepKey: "render",
      waitUntil: "2026-09-20T14:30:00",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("RFC3339");
  });
});
