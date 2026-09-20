import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../src/auth/guards";
import { createWorkflowRoutes } from "../src/workflows/routes";
import type {
  WorkflowAsset,
  WorkflowPlan,
  WorkflowRun,
  WorkflowStore,
} from "../src/workflows/store";

const actor = {
  id: "user-1",
  email: "member@openbot.test",
  role: "user",
} as const;

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "workflow-1",
    ownerUserId: actor.id,
    agentId: "agent-1",
    channelId: "channel-1",
    title: "Produce launch video",
    status: "active",
    finishedAt: null,
    createdAt: new Date("2026-09-20T01:00:00.000Z"),
    updatedAt: new Date("2026-09-20T02:00:00.000Z"),
    ...overrides,
  };
}

function plan(overrides: Partial<WorkflowPlan> = {}): WorkflowPlan {
  return {
    ...run(),
    steps: [
      {
        id: "step-1",
        workflowId: "workflow-1",
        key: "render",
        position: 0,
        instruction: "Render the approved scene.",
        dependsOn: [],
        status: "waiting",
        attempts: 2,
        provider: "flow",
        waitUntil: new Date("2026-09-20T03:00:00.000Z"),
        resumedFromWaitUntil: null,
        failureReason: null,
        startedAt: new Date("2026-09-20T01:30:00.000Z"),
        finishedAt: null,
        createdAt: new Date("2026-09-20T01:00:00.000Z"),
        updatedAt: new Date("2026-09-20T02:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

function asset(): WorkflowAsset {
  return {
    id: "asset-1",
    workflowId: "workflow-1",
    stepKey: "render",
    direction: "output",
    mediaKind: "video",
    ref: "workspace:scenes/01/final.mp4",
    label: "Scene 1",
    createdAt: new Date("2026-09-20T02:00:00.000Z"),
  };
}

type Call = [string, ...unknown[]];

function fakeStore(overrides: Partial<WorkflowStore> = {}) {
  const calls: Call[] = [];
  const unused = async () => {
    throw new Error("not used by these tests");
  };
  const store = {
    create: unused,
    get: unused,
    getForOwner: async (ownerUserId: string, id: string) => {
      calls.push(["getForOwner", ownerUserId, id]);
      return plan();
    },
    listFor: unused,
    listForOwner: async (ownerUserId: string) => {
      calls.push(["listForOwner", ownerUserId]);
      return [run()];
    },
    pause: async (identity: unknown, id: string) => {
      calls.push(["pause", identity, id]);
      return plan({ status: "paused" });
    },
    resume: async (identity: unknown, id: string) => {
      calls.push(["resume", identity, id]);
      return plan({ status: "active" });
    },
    cancel: async (identity: unknown, id: string) => {
      calls.push(["cancel", identity, id]);
      return plan({ status: "cancelled" });
    },
    fail: unused,
    startStep: unused,
    startReadyStep: unused,
    waitStep: unused,
    resumeWaitingStep: unused,
    completeStep: unused,
    failReadyStep: unused,
    failWaitingStep: unused,
    failAutonomousRunningStep: unused,
    failStep: unused,
    retryStep: unused,
    readySteps: unused,
    dueWaitingSteps: unused,
    addAsset: unused,
    listAssets: async (identity: unknown, id: string) => {
      calls.push(["listAssets", identity, id]);
      return [asset()];
    },
    removeAsset: unused,
    ...overrides,
  } as unknown as WorkflowStore;

  return { store, calls };
}

const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
  context,
  next,
) => {
  context.set("actor", actor);
  await next();
};

const denied: MiddlewareHandler<{ Variables: AppVariables }> = (context) =>
  Promise.resolve(context.json({ error: "denied" }, 401));

function appFor(
  store: WorkflowStore,
  middleware: MiddlewareHandler<{ Variables: AppVariables }> = requireUser,
) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/", createWorkflowRoutes(store, middleware));
  return app;
}

describe("workflow dashboard routes", () => {
  test("lists only the signed-in owner's workflows", async () => {
    const { store, calls } = fakeStore();
    const response = await appFor(store).request("http://openbot.test/");

    expect(response.status).toBe(200);
    expect((await response.json()).workflows).toEqual([
      {
        id: "workflow-1",
        agentId: "agent-1",
        channelId: "channel-1",
        title: "Produce launch video",
        status: "active",
        finishedAt: null,
        createdAt: "2026-09-20T01:00:00.000Z",
        updatedAt: "2026-09-20T02:00:00.000Z",
      },
    ]);
    expect(calls).toEqual([["listForOwner", actor.id]]);
  });

  test("loads detail and assets through the stored Bot identity", async () => {
    const { store, calls } = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/workflow-1",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.workflow.steps[0]).toMatchObject({
      key: "render",
      status: "waiting",
      attempts: 2,
      provider: "flow",
      waitUntil: "2026-09-20T03:00:00.000Z",
    });
    expect(body.assets[0]).toMatchObject({
      stepKey: "render",
      direction: "output",
      mediaKind: "video",
      ref: "workspace:scenes/01/final.mp4",
    });
    expect(calls).toEqual([
      ["getForOwner", actor.id, "workflow-1"],
      [
        "listAssets",
        { ownerUserId: actor.id, agentId: "agent-1" },
        "workflow-1",
      ],
    ]);
  });

  test("pauses through the owner plus Bot stored on the workflow", async () => {
    const { store, calls } = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/workflow-1/status",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pause" }),
      },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).workflow.status).toBe("paused");
    expect(calls).toEqual([
      ["getForOwner", actor.id, "workflow-1"],
      [
        "pause",
        { ownerUserId: actor.id, agentId: "agent-1" },
        "workflow-1",
      ],
    ]);
  });

  test("rejects unknown actions before any workflow is read", async () => {
    const { store, calls } = fakeStore();
    const response = await appFor(store).request(
      "http://openbot.test/workflow-1/status",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      },
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });

  test("refuses without a session before the store is asked", async () => {
    const { store, calls } = fakeStore();
    const response = await appFor(store, denied).request(
      "http://openbot.test/",
    );

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
