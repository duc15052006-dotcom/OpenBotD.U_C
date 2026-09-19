import type { AgentActor } from "../agents/profile-types";
import type { ChannelStore } from "../channels/routes";
import type { TurnRunner } from "../routines/runner";
import type { WorkflowIdentity, WorkflowStore } from "./store";

export type WorkflowContinuationInput = WorkflowIdentity & {
  workflowId: string;
  stepKey: string;
  expectedAttempt: number;
};

export type WorkflowRunner = {
  run(input: WorkflowContinuationInput): Promise<void>;
};

const UNCHECKPOINTED =
  "The autonomous continuation ended without checkpointing this workflow step.";

function continuationInstruction(input: {
  workflowId: string;
  stepKey: string;
  attempt: number;
  instruction: string;
}): string {
  return [
    "Resume this durable workflow step now.",
    "",
    `Workflow: ${input.workflowId}`,
    `Step: ${input.stepKey}`,
    `Attempt: ${input.attempt}`,
    `Task: ${input.instruction}`,
    "",
    "Before repeating any external submission or other side effect, inspect the current workflow, browser/service state and existing outputs. This wake may be a retry after a dispatch interruption, so never assume an earlier external action did not happen.",
    "Continue only this workflow step using the tools and permissions currently granted to you.",
    "Before this turn ends, checkpoint the step durably: complete it if finished, put it back into a future wait if an external job is still pending, or fail it with the concrete reason if it cannot continue.",
    "Do not busy-poll a generation service and do not start unrelated workflow steps.",
  ].join("\n");
}

export function createWorkflowRunner(options: {
  workflowStore: Pick<WorkflowStore, "get" | "failStep">;
  channelStore: ChannelStore;
  runTurn: TurnRunner;
}): WorkflowRunner {
  const { workflowStore, channelStore, runTurn } = options;

  return {
    async run(input) {
      const identity: WorkflowIdentity = {
        ownerUserId: input.ownerUserId,
        agentId: input.agentId,
      };
      const plan = await workflowStore.get(identity, input.workflowId);
      if (!plan || plan.status !== "active") return;

      const step = plan.steps.find(
        (candidate) => candidate.key === input.stepKey,
      );
      if (
        !step ||
        step.status !== "running" ||
        step.attempts !== input.expectedAttempt
      ) {
        return;
      }

      const owner: AgentActor = { id: input.ownerUserId, role: "user" };
      const channel = await channelStore.get(owner, plan.channelId);
      if (!channel) {
        await workflowStore.failStep(
          identity,
          input.workflowId,
          input.stepKey,
          "The workflow channel is gone.",
          input.expectedAttempt,
        );
        return;
      }

      const { replyText } = await runTurn({
        ownerUserId: input.ownerUserId,
        workflowId: input.workflowId,
        agentId: input.agentId,
        threadId: channel.threadId,
        instruction: continuationInstruction({
          workflowId: input.workflowId,
          stepKey: input.stepKey,
          attempt: input.expectedAttempt,
          instruction: step.instruction,
        }),
      });

      const after = await workflowStore.get(identity, input.workflowId);
      const checkpointed = after?.steps.find(
        (candidate) => candidate.key === input.stepKey,
      );
      if (
        checkpointed?.status === "running" &&
        checkpointed.attempts === input.expectedAttempt
      ) {
        await workflowStore.failStep(
          identity,
          input.workflowId,
          input.stepKey,
          UNCHECKPOINTED,
          input.expectedAttempt,
        );
      }

      try {
        await channelStore.recordActivity(owner, plan.channelId, {
          text: replyText,
          agentId: input.agentId,
          at: new Date(),
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            type: "workflow-activity-unrecorded",
            workflowId: input.workflowId,
            stepKey: input.stepKey,
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    },
  };
}
