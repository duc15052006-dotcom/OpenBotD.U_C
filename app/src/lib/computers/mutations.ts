import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/** Lifecycle controls. Reset is the only action that deletes the browser profile and workspace. */
export type ComputerAction = "start" | "restart" | "stop" | "reset";

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}

export function setComputerStateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      action: ComputerAction;
    }) => {
      await client(
        `/api/computers/${encodeURIComponent(variables.botId)}/computers/${variables.action}`,
        {
          method: "POST",
          ...(variables.action === "reset"
            ? {
                body: {
                  confirm: "RESET",
                  // Bind the destructive acknowledgement to the same Bot named in the URL. The
                  // server requires both, so an old dialog cannot wipe whichever Bot the route now
                  // points at.
                  botId: variables.botId,
                },
              }
            : {}),
          fallback: `The computer could not be ${variables.action}.`,
        },
      );
    },
    /** Only reset deletes the persistent Computer state, so only reset forgets local activity. */
    onSuccess: (_result, variables) => {
      if (variables.action === "reset") clearActivity(variables.botId);
      return invalidateComputers(queryClient);
    },
  });
}

export function stopAllComputersMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async () => {
      await client("/api/computers/stop-all", {
        method: "POST",
        fallback: "The Computers could not all be stopped.",
      });
    },
    onSuccess: () => invalidateComputers(queryClient),
  });
}

export function scanQuarantinedDownloadMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: { botId: string; id: string }) => {
      const response = await client(
        `/api/computers/${encodeURIComponent(variables.botId)}/quarantine/scan`,
        {
          method: "POST",
          body: { id: variables.id },
          fallback: "The quarantined file could not be scanned.",
        },
      );
      return response.json();
    },
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.quarantine(variables.botId),
      }),
  });
}

export function approveQuarantinedDownloadMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: { botId: string; id: string }) => {
      const response = await client(
        `/api/computers/${encodeURIComponent(variables.botId)}/quarantine/approve`,
        {
          method: "POST",
          body: {
            id: variables.id,
            botId: variables.botId,
            confirm: "APPROVE",
          },
          fallback: "The quarantined file could not be approved.",
        },
      );
      return response.json();
    },
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.quarantine(variables.botId),
      }),
  });
}

export function exportQuarantinedDownloadMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (variables: { botId: string; id: string }) => {
      const response = await client("/api/host-access/quarantine/export", {
        method: "POST",
        body: {
          botId: variables.botId,
          id: variables.id,
          confirm: "EXPORT_QUARANTINED_FILE",
        },
        fallback: "The quarantined file could not be exported.",
      });
      return response.json();
    },
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.quarantine(variables.botId),
      }),
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
export function saveActionPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (next: ActionPolicy): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallback: "The boundary could not be saved.",
      }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}
