import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
  workflowRuns,
  workflowSteps,
} from "../src/db/schema";
import {
  createWorkflowStore,
  WorkflowNotFoundError,
  WorkflowRefusedError,
} from "../src/workflows/store";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("workflow-test-deployment"),
);
const store = createWorkflowStore(database);

const prefix = `workflow-store-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
  for (const userId of createdUserIds) {
    await database
      .delete(workflowRuns)
      .where(eq(workflowRuns.ownerUserId, userId));
  }
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

async function createUser(): Promise<AgentActor> {
  const id = `${prefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Workflow Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(owner: AgentActor, name = "Producer") {
  const profile = await profileStore.create(owner, {
    name,
    title: "Content Producer",
    roleDescription: "Runs a multi-step content workflow.",
    visibility: "private",
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function createChannel(owner: AgentActor, agentIds: string[]) {
  const channel = await channelStore.create(owner, agentIds);
  createdChannelIds.push(channel.id);
  return channel;
}

async function setUp() {
  const owner = await createUser();
  const agentId = await createAgent(owner);
  const channel = await createChannel(owner, [agentId]);
  return { owner, agentId, channel };
}

function identity(owner: AgentActor, agentId: string) {
  return { ownerUserId: owner.id, agentId };
}

function planInput(
  owner: AgentActor,
  agentId: string,
  channelId: string,
) {
  return {
    ...identity(owner, agentId),
    channelId,
    title: "Produce a short product video",
    steps: [
      {
        key: "script",
        instruction: "Write the approved scene script.",
      },
      {
        key: "render",
        instruction: "Render the video from the approved script.",
        dependsOn: ["script"],
      },
      {
        key: "review",
        instruction: "Review the rendered video and collect the final output.",
        dependsOn: ["render"],
      },
    ],
  };
}

describe("durable workflow creation", () => {
  test("stores a bounded DAG and only roots begin ready", async () => {
    const { owner, agentId, channel } = await setUp();
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );

    expect(plan.status).toBe("active");
    expect(plan.steps.map((step) => [step.key, step.status])).toEqual([
      ["script", "ready"],
      ["render", "blocked"],
      ["review", "blocked"],
    ]);
    expect(plan.steps[1]?.dependsOn).toEqual(["script"]);
  });

  test("refuses forward, missing and duplicate dependencies", async () => {
    const { owner, agentId, channel } = await setUp();

    await expect(
      store.create({
        ...identity(owner, agentId),
        channelId: channel.id,
        title: "Bad graph",
        steps: [
          {
            key: "later",
            instruction: "Wait for a future step.",
            dependsOn: ["future"],
          },
          { key: "future", instruction: "This arrives too late." },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkflowRefusedError);

    await expect(
      store.create({
        ...identity(owner, agentId),
        channelId: channel.id,
        title: "Duplicate",
        steps: [
          { key: "same", instruction: "First." },
          { key: "same", instruction: "Second." },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkflowRefusedError);
  });

  test("refuses a channel this owner and Bot do not share", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Producer");
    const otherAgent = await createAgent(owner, "Reviewer");
    const otherChannel = await createChannel(owner, [otherAgent]);

    await expect(
      store.create(
        planInput(owner, agentId, otherChannel.id),
      ),
    ).rejects.toBeInstanceOf(WorkflowRefusedError);
  });
});

describe("owner and Bot isolation", () => {
  test("another person and another Bot cannot read or mutate the workflow", async () => {
    const { owner, agentId, channel } = await setUp();
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );
    const stranger = await createUser();
    const siblingAgent = await createAgent(owner, "Sibling");

    expect(
      await store.get(identity(stranger, agentId), plan.id),
    ).toBeNull();
    expect(
      await store.get(identity(owner, siblingAgent), plan.id),
    ).toBeNull();

    await expect(
      store.pause(identity(stranger, agentId), plan.id),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      store.startStep(identity(owner, siblingAgent), plan.id, "script"),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
});

describe("dependency and lifecycle transitions", () => {
  test("completion promotes dependencies and the last step completes the run", async () => {
    const { owner, agentId, channel } = await setUp();
    const who = identity(owner, agentId);
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );

    const first = await store.startStep(who, plan.id, "script");
    expect(first.status).toBe("running");
    expect(first.attempts).toBe(1);

    const afterScript = await store.completeStep(who, plan.id, "script");
    expect(
      afterScript.steps.find((step) => step.key === "render")?.status,
    ).toBe("ready");

    await store.startStep(who, plan.id, "render");
    const afterRender = await store.completeStep(who, plan.id, "render");
    expect(
      afterRender.steps.find((step) => step.key === "review")?.status,
    ).toBe("ready");

    await store.startStep(who, plan.id, "review");
    const done = await store.completeStep(who, plan.id, "review");
    expect(done.status).toBe("succeeded");
    expect(done.finishedAt).toBeInstanceOf(Date);
  });

  test("pause blocks new work, resume restores it, and cancel closes pending steps", async () => {
    const { owner, agentId, channel } = await setUp();
    const who = identity(owner, agentId);
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );

    expect((await store.pause(who, plan.id)).status).toBe("paused");
    await expect(
      store.startStep(who, plan.id, "script"),
    ).rejects.toBeInstanceOf(WorkflowRefusedError);

    expect((await store.resume(who, plan.id)).status).toBe("active");
    await store.startStep(who, plan.id, "script");

    const cancelled = await store.cancel(who, plan.id);
    expect(cancelled.status).toBe("cancelled");
    expect(
      cancelled.steps.every((step) => step.status === "cancelled"),
    ).toBe(true);
  });

  test("a failed step can be retried without losing its attempt history", async () => {
    const { owner, agentId, channel } = await setUp();
    const who = identity(owner, agentId);
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );

    await store.startStep(who, plan.id, "script");
    const failed = await store.failStep(
      who,
      plan.id,
      "script",
      "temporary provider outage",
    );
    expect(failed.status).toBe("failed");
    expect(failed.attempts).toBe(1);

    const ready = await store.retryStep(who, plan.id, "script");
    expect(ready.status).toBe("ready");
    const second = await store.startStep(who, plan.id, "script");
    expect(second.attempts).toBe(2);
  });
});

describe("durable waits", () => {
  test("a waiting step is discoverable when due and stale wakes cannot resume it", async () => {
    const { owner, agentId, channel } = await setUp();
    const who = identity(owner, agentId);
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );
    await store.startStep(who, plan.id, "script");

    const original = new Date(Date.now() + 60_000);
    const waiting = await store.waitStep(who, plan.id, "script", {
      waitUntil: original,
      provider: "video-generator",
    });
    expect(waiting.status).toBe("waiting");
    expect(waiting.provider).toBe("video-generator");

    const dueAt = new Date(Date.now() - 60_000);
    await database
      .update(workflowSteps)
      .set({ waitUntil: dueAt })
      .where(eq(workflowSteps.id, waiting.id));

    const due = await store.dueWaitingSteps(20);
    expect(due).toContainEqual({
      ownerUserId: owner.id,
      agentId,
      workflowId: plan.id,
      stepKey: "script",
      waitUntil: dueAt,
    });

    await expect(
      store.resumeWaitingStep(who, plan.id, "script", original),
    ).rejects.toBeInstanceOf(WorkflowRefusedError);

    const resumed = await store.resumeWaitingStep(
      who,
      plan.id,
      "script",
      dueAt,
    );
    expect(resumed.status).toBe("running");
    expect(resumed.waitUntil).toBeNull();
  });
});

describe("deleted Agents leave no stale workflow", () => {
  test("the Agent foreign key cascades its pending workflow and steps", async () => {
    const { owner, agentId, channel } = await setUp();
    const who = identity(owner, agentId);
    const plan = await store.create(
      planInput(owner, agentId, channel.id),
    );

    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));

    expect(await store.get(who, plan.id)).toBeNull();
    const rows = await database
      .select({ id: workflowSteps.id })
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, plan.id));
    expect(rows).toEqual([]);
  });
});
