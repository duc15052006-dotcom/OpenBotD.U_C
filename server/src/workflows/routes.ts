import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import {
  WorkflowNotFoundError,
  WorkflowRefusedError,
  type WorkflowAsset,
  type WorkflowPlan,
  type WorkflowRun,
  type WorkflowStore,
} from "./store";

type WorkflowListDto = {
  id: string;
  agentId: string;
  channelId: string;
  title: string;
  status: WorkflowRun["status"];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

type WorkflowDetailDto = {
  workflow: {
    id: string;
    agentId: string;
    channelId: string;
    title: string;
    status: WorkflowPlan["status"];
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
    steps: Array<{
      key: string;
      position: number;
      instruction: string;
      dependsOn: string[];
      status: WorkflowPlan["steps"][number]["status"];
      attempts: number;
      provider: string | null;
      waitUntil: string | null;
      failureReason: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      updatedAt: string;
    }>;
  };
  assets: Array<{
    id: string;
    stepKey: string;
    direction: WorkflowAsset["direction"];
    mediaKind: WorkflowAsset["mediaKind"];
    ref: string;
    label: string | null;
    createdAt: string;
  }>;
};

export function createWorkflowRoutes(
  workflowStore: WorkflowStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.get("/", requireUser, async (context) => {
    const rows = await workflowStore.listForOwner(context.var.actor.id);
    return context.json({ workflows: rows.map(runDto) });
  });

  routes.get("/:id", requireUser, async (context) => {
    const id = context.req.param("id").trim();
    if (!id) return context.json({ error: "A workflow id is required." }, 400);

    const plan = await workflowStore.getForOwner(context.var.actor.id, id);
    if (!plan) {
      return context.json({ error: "That workflow does not exist." }, 404);
    }

    const assets = await workflowStore.listAssets(
      { ownerUserId: context.var.actor.id, agentId: plan.agentId },
      id,
    );
    return context.json(detailDto(plan, assets));
  });

  routes.put("/:id/status", requireUser, async (context) => {
    const id = context.req.param("id").trim();
    if (!id) return context.json({ error: "A workflow id is required." }, 400);

    const body = (await context.req.json().catch(() => null)) as {
      action?: unknown;
    } | null;
    const action = body?.action;
    if (!["pause", "resume", "cancel"].includes(String(action))) {
      return context.json(
        { error: "action must be pause, resume, or cancel." },
        400,
      );
    }

    const plan = await workflowStore.getForOwner(context.var.actor.id, id);
    if (!plan) {
      return context.json({ error: "That workflow does not exist." }, 404);
    }
    const identity = {
      ownerUserId: context.var.actor.id,
      agentId: plan.agentId,
    };

    try {
      const next =
        action === "pause"
          ? await workflowStore.pause(identity, id)
          : action === "resume"
            ? await workflowStore.resume(identity, id)
            : await workflowStore.cancel(identity, id);
      return context.json({ workflow: detailDto(next, []).workflow });
    } catch (error) {
      return mapStoreError(context, error);
    }
  });

  return routes;
}

function runDto(run: WorkflowRun): WorkflowListDto {
  return {
    id: run.id,
    agentId: run.agentId,
    channelId: run.channelId,
    title: run.title,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function detailDto(
  plan: WorkflowPlan,
  assets: WorkflowAsset[],
): WorkflowDetailDto {
  return {
    workflow: {
      ...runDto(plan),
      steps: plan.steps.map((step) => ({
        key: step.key,
        position: step.position,
        instruction: step.instruction,
        dependsOn: step.dependsOn,
        status: step.status,
        attempts: step.attempts,
        provider: step.provider,
        waitUntil: step.waitUntil?.toISOString() ?? null,
        failureReason: step.failureReason,
        startedAt: step.startedAt?.toISOString() ?? null,
        finishedAt: step.finishedAt?.toISOString() ?? null,
        updatedAt: step.updatedAt.toISOString(),
      })),
    },
    assets: assets.map((asset) => ({
      id: asset.id,
      stepKey: asset.stepKey,
      direction: asset.direction,
      mediaKind: asset.mediaKind,
      ref: asset.ref,
      label: asset.label,
      createdAt: asset.createdAt.toISOString(),
    })),
  };
}

function mapStoreError(context: Context, error: unknown): Response {
  if (error instanceof WorkflowNotFoundError) {
    return context.json({ error: error.message }, 404);
  }
  if (error instanceof WorkflowRefusedError) {
    return context.json({ error: error.message }, 400);
  }
  throw error;
}
