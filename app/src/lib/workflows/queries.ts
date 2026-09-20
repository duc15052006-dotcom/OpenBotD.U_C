import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type WorkflowStatus =
  | "active"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowStepStatus =
  | "blocked"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type WorkflowRecord = {
  id: string;
  agentId: string;
  channelId: string;
  title: string;
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type WorkflowStepRecord = {
  key: string;
  position: number;
  instruction: string;
  dependsOn: string[];
  status: WorkflowStepStatus;
  attempts: number;
  provider: string | null;
  waitUntil: string | null;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type WorkflowAssetRecord = {
  id: string;
  stepKey: string;
  direction: "input" | "output";
  mediaKind: "image" | "video" | "audio" | "file" | "text";
  ref: string;
  label: string | null;
  createdAt: string;
};

export type WorkflowDetail = {
  workflow: WorkflowRecord & { steps: WorkflowStepRecord[] };
  assets: WorkflowAssetRecord[];
};

export const workflowKeys = {
  all: ["workflows"] as const,
  list: () => ["workflows", "list"] as const,
  detail: (id: string) => ["workflows", "detail", id] as const,
};

export function workflowsQueryOptions() {
  return queryOptions({
    queryKey: workflowKeys.list(),
    queryFn: async (): Promise<WorkflowRecord[]> =>
      client<WorkflowRecord[]>("/api/workflows", "workflows", {
        fallback: "Your workflows could not be loaded.",
      }),
  });
}

export function workflowDetailQueryOptions(id: string | null) {
  return queryOptions({
    queryKey: workflowKeys.detail(id ?? ""),
    enabled: Boolean(id),
    queryFn: async (): Promise<WorkflowDetail> => {
      if (!id) throw new Error("A workflow id is required.");
      const response = await client(`/api/workflows/${encodeURIComponent(id)}`, {
        fallback: "That workflow could not be loaded.",
      });
      return (await response.json()) as WorkflowDetail;
    },
  });
}
