import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import {
  type AgentInstructionsSettings,
  type AgentKnowledgeSettings,
  type AgentMemorySettings,
  type AgentModelConnection,
  type AgentModelProvider,
  type AgentModelSettings,
  type AgentProfile,
  type AgentVisibility,
  agentApiPath,
  agentKeys,
} from "./queries";

export type AgentModelInput =
  | { mode: "global" }
  | {
      mode: "custom";
      provider: AgentModelProvider;
      model: string;
      credentialSource: "global" | "custom";
      apiKey?: string;
      baseUrl?: string;
      temperature?: number;
      maxTokens?: number;
      fallback?: { provider: AgentModelProvider; model: string };
    };

export type AgentInput = {
  name: string;
  title: string;
  roleDescription: string;
  visibility: AgentVisibility;
  /** Where this coworker runs. Empty means the Bot in the box. */
  endpoint?: string;
  /** Write-only auth value; omitted when the user leaves the key field empty. */
  auth?: { header: string; value: string };
};

/** The sentence for every write here, since they all fail the same way to a reader. */
const FALLBACK = "Coworker operation failed";

/** Server-derived fields are invalidated instead of patched by hand. */
function invalidateAgents(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export function createAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (input: AgentInput): Promise<AgentProfile> =>
      client("/api/agents", "agent", {
        method: "POST",
        body: input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function updateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentInput;
    }): Promise<AgentProfile> =>
      client(agentApiPath(variables.agentId), "agent", {
        method: "PATCH",
        body: variables.input,
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function duplicateAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentProfile> =>
      client(`${agentApiPath(agentId)}/duplicate`, "agent", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function setAgentHiddenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: { agentId: string; hidden: boolean }) => {
      await client(
        `${agentApiPath(variables.agentId)}/${variables.hidden ? "hide" : "unhide"}`,
        { method: "POST", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function deleteAgentMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(agentApiPath(agentId), {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

export function saveAgentModelMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      input: AgentModelInput;
    }): Promise<AgentModelSettings> =>
      client(`${agentApiPath(variables.agentId)}/model`, "model", {
        method: "PUT",
        body: variables.input,
        fallback: "Could not save model settings",
      }),
    onSuccess: (model, variables) => {
      queryClient.setQueryData(agentKeys.model(variables.agentId), model);
    },
  });
}

export function testAgentModelMutationOptions() {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<AgentModelConnection> =>
      client(`${agentApiPath(agentId)}/model/test`, "connection", {
        method: "POST",
        fallback: "Could not test the model connection",
      }),
  });
}

export function saveAgentMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      memory: string;
      baseRevisionId: string | null;
    }): Promise<AgentMemorySettings> =>
      client(`${agentApiPath(variables.agentId)}/memory`, "memory", {
        method: "PUT",
        body: {
          memory: variables.memory,
          baseRevisionId: variables.baseRevisionId,
        },
        fallback: "Could not save Agent memory",
      }),
    onSuccess: (memory, variables) => {
      queryClient.setQueryData(agentKeys.memory(variables.agentId), memory);
      void queryClient.invalidateQueries({
        queryKey: agentKeys.memoryHistory(variables.agentId),
      });
    },
    onError: (_error, variables) =>
      queryClient.invalidateQueries({
        queryKey: agentKeys.memory(variables.agentId),
      }),
  });
}

export function undoAgentMemoryMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      revisionId: string;
      baseRevisionId: string | null;
    }): Promise<AgentMemorySettings> =>
      client(`${agentApiPath(variables.agentId)}/memory/undo`, "memory", {
        method: "POST",
        body: {
          revisionId: variables.revisionId,
          baseRevisionId: variables.baseRevisionId,
        },
        fallback: "Could not restore that Agent memory revision",
      }),
    onSuccess: (memory, variables) => {
      queryClient.setQueryData(agentKeys.memory(variables.agentId), memory);
      void queryClient.invalidateQueries({
        queryKey: agentKeys.memoryHistory(variables.agentId),
      });
    },
    onError: (_error, variables) =>
      queryClient.invalidateQueries({
        queryKey: agentKeys.memory(variables.agentId),
      }),
  });
}

export function saveAgentInstructionsMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      instructions: string;
    }): Promise<AgentInstructionsSettings> =>
      client(
        `${agentApiPath(variables.agentId)}/instructions`,
        "instructions",
        {
          method: "PUT",
          body: { instructions: variables.instructions },
          fallback: "Could not save Agent instructions",
        },
      ),
    onSuccess: (instructions, variables) => {
      queryClient.setQueryData(
        agentKeys.instructions(variables.agentId),
        instructions,
      );
    },
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

export function uploadAgentKnowledgeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      agentId: string;
      file: File;
      maxBytes: number;
    }): Promise<AgentKnowledgeSettings> => {
      /*
       * Refuse before arrayBuffer(). The server is authoritative, but without this browser-side
       * guard a dragged multi-gigabyte file would be read into this tab just to be rejected later.
       */
      if (variables.file.size > variables.maxBytes) {
        throw new Error(
          `Knowledge files are limited to ${variables.maxBytes} bytes.`,
        );
      }
      const bytes = new Uint8Array(await variables.file.arrayBuffer());
      return client(
        `${agentApiPath(variables.agentId)}/knowledge`,
        "knowledge",
        {
          method: "POST",
          body: {
            name: variables.file.name,
            mimeType: variables.file.type,
            bytesBase64: bytesToBase64(bytes),
          },
          fallback: "Could not upload Agent knowledge",
        },
      );
    },
    onSuccess: (knowledge, variables) => {
      queryClient.setQueryData(
        agentKeys.knowledge(variables.agentId),
        knowledge,
      );
    },
  });
}

export function removeAgentKnowledgeMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      agentId: string;
      documentId: string;
    }): Promise<AgentKnowledgeSettings> =>
      client(
        `${agentApiPath(variables.agentId)}/knowledge/${encodeURIComponent(
          variables.documentId,
        )}`,
        "knowledge",
        {
          method: "DELETE",
          fallback: "Could not remove Agent knowledge",
        },
      ),
    onSuccess: (knowledge, variables) => {
      queryClient.setQueryData(
        agentKeys.knowledge(variables.agentId),
        knowledge,
      );
    },
  });
}

/**
 * Issue this coworker a credential for calling tools back, and hand it over once.
 *
 * The token is in this response and nowhere else, ever again, so the caller has to show it to the
 * person immediately. Calling this on a coworker that already has one rotates it, which is how a
 * leaked token is retired.
 */
export function issueCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (agentId: string): Promise<string> =>
      client(`${agentApiPath(agentId)}/callback-token`, "token", {
        method: "POST",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/** Take the credential away. The coworker may still talk; it may not reach anything outside a chat. */
export function revokeCallbackTokenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (agentId: string) => {
      await client(`${agentApiPath(agentId)}/callback-token`, {
        method: "DELETE",
        fallback: FALLBACK,
      });
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}

/**
 * Whether one Bot may hand work to another.
 *
 * The same `plugin_grants` write every other grant makes, with `kind: "bot"`, so the audit row and
 * the refusals are the ones already in place: an administrator only, never a Bot on itself, and
 * never onto a Bot that does not exist.
 *
 * DIRECTIONAL, and the two ids are easy to swap: `agentId` is the Bot doing the asking and `ref` is
 * the Bot it may reach. Granted the other way round it reads as working and hands over nothing.
 */
export function setHandoffGrantMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      /** The Bot doing the asking. */
      agentId: string;
      /** The Bot it may reach. */
      ref: string;
      granted: boolean;
    }) => {
      if (variables.granted) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "bot", ref: variables.ref, agentId: variables.agentId },
          fallback: FALLBACK,
        });
        return;
      }
      await client(
        `/api/plugins/grants?kind=bot&ref=${encodeURIComponent(variables.ref)}&agentId=${encodeURIComponent(variables.agentId)}`,
        { method: "DELETE", fallback: FALLBACK },
      );
    },
    onSuccess: () => invalidateAgents(queryClient),
  });
}
