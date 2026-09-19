import { cutAtCodeUnits } from "../channels/text";
import {
  type WorkflowAssetInput,
  type WorkflowIdentity,
  WorkflowNotFoundError,
  type WorkflowPlan,
  WorkflowRefusedError,
  type WorkflowStepInput,
  type WorkflowStore,
} from "../workflows/store";
import { MAX_RESULT_CHARS, type McpCallResult, type McpTool } from "./mcp";

export type WorkflowTools = Pick<
  WorkflowStore,
  | "create"
  | "get"
  | "listFor"
  | "pause"
  | "resume"
  | "cancel"
  | "startStep"
  | "waitStep"
  | "completeStep"
  | "failStep"
  | "retryStep"
  | "addAsset"
  | "listAssets"
  | "removeAsset"
>;

let installed: WorkflowTools | null = null;

export function useWorkflowTools(tools: WorkflowTools | null): void {
  installed = tools;
}

type Connection = {
  url: string;
  token?: string;
  actorId?: string;
  botId?: string;
};

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "create_workflow",
    description:
      "Create a durable multi-step workflow for the current person and Bot. Dependencies may name only earlier step keys in this workflow.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string" },
        title: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              instruction: { type: "string" },
              dependsOn: { type: "array", items: { type: "string" } },
            },
            required: ["key", "instruction"],
          },
        },
      },
      required: ["channelId", "title", "steps"],
    },
  },
  {
    name: "list_workflows",
    description:
      "List durable workflows owned by the current person and this Bot.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_workflow",
    description: "Read one durable workflow and all of its current step state.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "pause_workflow",
    description:
      "Pause an active workflow without deleting its durable step, wait, attempt or asset state.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "resume_workflow",
    description:
      "Resume a paused workflow. Existing persisted waits and attempts are preserved.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "cancel_workflow",
    description:
      "Cancel a workflow and all still-active steps. This is terminal for that workflow.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "start_workflow_step",
    description:
      "Atomically move one ready workflow step to running and increment its durable attempt count.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
      },
      required: ["id", "stepKey"],
    },
  },
  {
    name: "wait_workflow_step",
    description:
      "Put one running step to sleep until an exact future RFC3339 timestamp. Use this instead of busy-polling an external generation job.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
        waitUntil: {
          type: "string",
          description:
            "Absolute future RFC3339 timestamp with Z or an explicit numeric UTC offset.",
        },
        provider: {
          type: "string",
          description:
            "Optional provider label only. Never put credentials or secrets here.",
        },
      },
      required: ["id", "stepKey", "waitUntil"],
    },
  },
  {
    name: "complete_workflow_step",
    description:
      "Mark one running step succeeded. Newly satisfied dependent steps become ready atomically.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
      },
      required: ["id", "stepKey"],
    },
  },
  {
    name: "fail_workflow_step",
    description:
      "Mark one running step failed and persist a bounded failure reason for recovery or retry.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
        reason: { type: "string" },
      },
      required: ["id", "stepKey", "reason"],
    },
  },
  {
    name: "retry_workflow_step",
    description:
      "Move a failed step back to ready when its dependencies still succeeded. The prior attempt count remains durable.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
      },
      required: ["id", "stepKey"],
    },
  },
  {
    name: "add_workflow_asset",
    description:
      "Attach bounded asset metadata to one workflow step. References may only be attachment:<uuid> or workspace:<safe-relative-path>; this grants no file access.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
        direction: { type: "string", enum: ["input", "output"] },
        mediaKind: {
          type: "string",
          enum: ["image", "video", "audio", "file", "text"],
        },
        ref: { type: "string" },
        label: { type: "string" },
      },
      required: ["id", "stepKey", "direction", "mediaKind", "ref"],
    },
  },
  {
    name: "list_workflow_assets",
    description:
      "List asset metadata for one workflow, optionally limited to one step. Underlying file bytes remain behind existing file and attachment permissions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        stepKey: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "remove_workflow_asset",
    description:
      "Remove one workflow asset metadata entry. This does not delete the underlying file or attachment.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        assetId: { type: "string" },
      },
      required: ["id", "assetId"],
    },
  },
]);

export async function listTools(): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

export const listNeedsCredential = false;

type FailedResult = McpCallResult & { isError: true };

const failure = (message: string): FailedResult => ({
  text: message,
  isError: true,
  truncated: false,
});

function result(value: unknown): McpCallResult {
  const text = JSON.stringify(value, null, 2) ?? "null";
  if (text.length <= MAX_RESULT_CHARS) {
    return { text, isError: false, truncated: false };
  }
  return {
    text: `${cutAtCodeUnits(text, MAX_RESULT_CHARS)}\n\n[truncated: the tool returned ${text.length} characters]`,
    isError: false,
    truncated: true,
  };
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requiredString(
  args: Record<string, unknown>,
  key: string,
): string | FailedResult {
  const value = stringArg(args, key);
  return value ?? failure(`A workflow call needs ${key}.`);
}

function identityOf(connection: Connection): WorkflowIdentity | FailedResult {
  const ownerUserId = connection.actorId?.trim();
  if (!ownerUserId) {
    return failure(
      "A workflow belongs to somebody, and this run is not attributed to anybody.",
    );
  }
  const agentId = connection.botId?.trim();
  if (!agentId) {
    return failure(
      "A workflow belongs to a Bot, and this run does not name one.",
    );
  }
  return { ownerUserId, agentId };
}

function isFailure(value: unknown): value is FailedResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "isError" in value &&
    (value as McpCallResult).isError === true
  );
}

function stepsArg(value: unknown): WorkflowStepInput[] | FailedResult {
  if (!Array.isArray(value)) return failure("A workflow needs a steps array.");
  const steps: WorkflowStepInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      return failure("Every workflow step must be an object.");
    }
    const item = raw as Record<string, unknown>;
    const key = typeof item.key === "string" ? item.key : undefined;
    const instruction =
      typeof item.instruction === "string" ? item.instruction : undefined;
    if (!key || !instruction) {
      return failure("Every workflow step needs key and instruction.");
    }
    if (
      item.dependsOn !== undefined &&
      (!Array.isArray(item.dependsOn) ||
        item.dependsOn.some((entry) => typeof entry !== "string"))
    ) {
      return failure(
        "A workflow step dependsOn must be an array of step keys.",
      );
    }
    steps.push({
      key,
      instruction,
      ...(Array.isArray(item.dependsOn)
        ? { dependsOn: item.dependsOn as string[] }
        : {}),
    });
  }
  return steps;
}

function absoluteTimestamp(value: string | undefined): Date | undefined {
  if (!value || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function compactPlan(plan: WorkflowPlan | null) {
  if (!plan) return null;
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    channelId: plan.channelId,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    steps: plan.steps.map((step) => ({
      key: step.key,
      status: step.status,
      attempts: step.attempts,
      provider: step.provider,
      waitUntil: step.waitUntil,
      failureReason: step.failureReason,
      dependsOn: step.dependsOn,
      instruction: step.instruction,
    })),
  };
}

export async function callTool(
  connection: Connection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const identity = identityOf(connection);
  if (isFailure(identity)) return identity;
  const tools = installed;
  if (!tools) return failure("Workflows is not available in this deployment.");

  try {
    if (toolName === "create_workflow") {
      const channelId = requiredString(args, "channelId");
      if (isFailure(channelId)) return channelId;
      const title = requiredString(args, "title");
      if (isFailure(title)) return title;
      const steps = stepsArg(args.steps);
      if (isFailure(steps)) return steps;
      return result(
        compactPlan(
          await tools.create({
            ...identity,
            channelId,
            title,
            steps,
          }),
        ),
      );
    }
    if (toolName === "list_workflows") {
      return result(await tools.listFor(identity));
    }

    const id = requiredString(args, "id");
    if (isFailure(id)) return id;

    if (toolName === "get_workflow") {
      const plan = await tools.get(identity, id);
      if (!plan) return failure("That workflow does not exist.");
      return result(compactPlan(plan));
    }
    if (toolName === "pause_workflow") {
      return result(compactPlan(await tools.pause(identity, id)));
    }
    if (toolName === "resume_workflow") {
      return result(compactPlan(await tools.resume(identity, id)));
    }
    if (toolName === "cancel_workflow") {
      return result(compactPlan(await tools.cancel(identity, id)));
    }
    if (toolName === "list_workflow_assets") {
      return result(
        await tools.listAssets(identity, id, stringArg(args, "stepKey")),
      );
    }
    if (toolName === "remove_workflow_asset") {
      const assetId = requiredString(args, "assetId");
      if (isFailure(assetId)) return assetId;
      await tools.removeAsset(identity, id, assetId);
      return result({ removed: assetId });
    }

    const stepKey = requiredString(args, "stepKey");
    if (isFailure(stepKey)) return stepKey;

    if (toolName === "start_workflow_step") {
      return result(await tools.startStep(identity, id, stepKey));
    }
    if (toolName === "wait_workflow_step") {
      /*
       * Parse shape here, but do not decide "future" from this process clock. The workflow store
       * validates the exact timestamp against PostgreSQL inside the same transaction that changes
       * the step. Otherwise a laptop/VM clock skew can refuse a timestamp the durable scheduler
       * itself still considers future.
       */
      const waitUntil = absoluteTimestamp(stringArg(args, "waitUntil"));
      if (!waitUntil) {
        return failure(
          "waitUntil must be an absolute future RFC3339 timestamp with Z or a numeric UTC offset.",
        );
      }
      const provider = stringArg(args, "provider");
      return result(
        await tools.waitStep(identity, id, stepKey, {
          waitUntil,
          ...(provider ? { provider } : {}),
        }),
      );
    }
    if (toolName === "complete_workflow_step") {
      return result(
        compactPlan(await tools.completeStep(identity, id, stepKey)),
      );
    }
    if (toolName === "fail_workflow_step") {
      const reason = requiredString(args, "reason");
      if (isFailure(reason)) return reason;
      return result(await tools.failStep(identity, id, stepKey, reason));
    }
    if (toolName === "retry_workflow_step") {
      return result(await tools.retryStep(identity, id, stepKey));
    }
    if (toolName === "add_workflow_asset") {
      const direction = stringArg(args, "direction");
      const mediaKind = stringArg(args, "mediaKind");
      const ref = requiredString(args, "ref");
      if (isFailure(ref)) return ref;
      if (direction !== "input" && direction !== "output") {
        return failure("direction must be input or output.");
      }
      if (
        mediaKind !== "image" &&
        mediaKind !== "video" &&
        mediaKind !== "audio" &&
        mediaKind !== "file" &&
        mediaKind !== "text"
      ) {
        return failure("mediaKind must be image, video, audio, file or text.");
      }
      const label = stringArg(args, "label");
      const input: WorkflowAssetInput = {
        direction,
        mediaKind,
        ref,
        ...(label ? { label } : {}),
      };
      return result(await tools.addAsset(identity, id, stepKey, input));
    }
    return failure(`Unknown workflow tool: ${toolName}.`);
  } catch (error) {
    if (
      error instanceof WorkflowRefusedError ||
      error instanceof WorkflowNotFoundError
    ) {
      return failure(error.message);
    }
    return failure("The workflow operation could not be completed.");
  }
}
