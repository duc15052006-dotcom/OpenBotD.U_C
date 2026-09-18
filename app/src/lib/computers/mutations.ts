import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/** Lifecycle controls. Reset is the only action that deletes the saved browser profile. */
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
          fallback: `The computer could not be ${variables.action}.`,
        },
      );
    },
    /** Only reset deletes the profile those commands ran on, so only reset forgets local activity. */
    onSuccess: (_result, variables) => {
      if (variables.action === "reset") clearActivity(variables.botId);
      return invalidateComputers(queryClient);
    },
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
