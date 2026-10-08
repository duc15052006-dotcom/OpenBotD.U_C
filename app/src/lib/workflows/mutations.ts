import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { workflowKeys } from "./queries";

export type WorkflowAction = "pause" | "resume" | "cancel";

const FALLBACK = "That workflow could not be changed.";

export function setWorkflowStatusMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { id: string; action: WorkflowAction }) =>
      client(`/api/workflows/${encodeURIComponent(variables.id)}/status`, {
        method: "PUT",
        body: { action: variables.action },
        fallback: FALLBACK,
      }),
    onSuccess: (_response, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: workflowKeys.all }),
        queryClient.invalidateQueries({
          queryKey: workflowKeys.detail(variables.id),
        }),
      ]),
  });
}
