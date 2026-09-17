import type { AgentModelConfigStore } from "./model-config-store";
import {
  testAgentModelConnection,
  type ModelConnectionResult,
  type ModelProbeFetch,
} from "./model-connection";
import type { AgentActor } from "./profile-types";
import {
  type DeploymentRuntimeModel,
  type ResolveProviderApiKey,
  resolveAgentRuntimeModel,
} from "./runtime-model";

export type AgentModelConnectionService = {
  test(actor: AgentActor, agentId: string): Promise<ModelConnectionResult>;
};

/**
 * Build the settings-screen Test Connection action from the same resolver the runtime uses.
 *
 * The only difference is authorization: a chat run reaches `modelConfigs.resolve` after the runtime
 * has already built a permission-filtered roster; this action begins with a person clicking a button,
 * so it must use `resolveManaged` before a real credential is decrypted. The adapter below keeps the
 * model-selection logic itself single-sourced in `resolveAgentRuntimeModel`.
 */
export function createAgentModelConnectionService(input: {
  deployment: DeploymentRuntimeModel;
  modelConfigs: Pick<AgentModelConfigStore, "resolveManaged">;
  resolveProviderApiKey: ResolveProviderApiKey;
  guardedFetch: ModelProbeFetch;
  timeoutMs?: number;
}): AgentModelConnectionService {
  return {
    async test(actor, agentId) {
      const runtime = await resolveAgentRuntimeModel({
        agentId,
        deployment: input.deployment,
        modelConfigs: {
          resolve: (id) => input.modelConfigs.resolveManaged(actor, id),
        },
        resolveProviderApiKey: input.resolveProviderApiKey,
      });
      return testAgentModelConnection(
        runtime,
        input.guardedFetch,
        input.timeoutMs,
      );
    },
  };
}
