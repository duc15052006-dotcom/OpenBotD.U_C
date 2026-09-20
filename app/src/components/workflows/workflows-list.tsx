import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemTitle,
} from "@/components/ui/item";
import { agentListQueryOptions } from "@/lib/agents/queries";
import { relativeTime } from "@/lib/relative-time";
import { setWorkflowStatusMutationOptions } from "@/lib/workflows/mutations";
import {
  type WorkflowStatus,
  workflowDetailQueryOptions,
  workflowsQueryOptions,
} from "@/lib/workflows/queries";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

function Chip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-background/60 px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function statusClass(status: WorkflowStatus): string {
  if (status === "failed" || status === "cancelled") return "text-destructive";
  if (status === "succeeded") return "text-emerald-600 dark:text-emerald-500";
  if (status === "paused") return "text-amber-600 dark:text-amber-500";
  return "text-foreground";
}

export function WorkflowsList() {
  const workflows = useQuery(workflowsQueryOptions());
  const agents = useQuery(agentListQueryOptions());
  const mutate = useMutation(setWorkflowStatusMutationOptions(queryClient));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useQuery(workflowDetailQueryOptions(selectedId));
  const selected =
    workflows.data?.find((workflow) => workflow.id === selectedId) ?? null;
  const agentName = (agentId: string) =>
    agents.data?.find((agent) => agent.id === agentId)?.name ?? "Coworker";

  return (
    <PageSection>
      {workflows.isPending ? null : workflows.error ? (
        <p className="text-destructive text-sm" role="alert">
          Your workflows could not be loaded.
        </p>
      ) : (workflows.data?.length ?? 0) === 0 ? (
        <Empty className="h-[180px] border border-dashed">
          <EmptyHeader>
            <EmptyTitle className="text-muted-foreground">
              No durable workflows yet
            </EmptyTitle>
            <EmptyDescription>
              Ask a coworker to carry out substantial multi-step work and its
              durable progress will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {workflows.data?.map((workflow) => (
            <Item key={workflow.id} variant="muted">
              <ItemContent>
                <ItemTitle>{workflow.title}</ItemTitle>
                <ItemDescription>
                  {agentName(workflow.agentId)} · updated{" "}
                  {relativeTime(workflow.updatedAt)}
                </ItemDescription>
                <ItemFooter>
                  <div className="flex flex-wrap gap-1.5">
                    <Chip className={statusClass(workflow.status)}>
                      {workflow.status}
                    </Chip>
                    {workflow.finishedAt ? (
                      <Chip>finished {relativeTime(workflow.finishedAt)}</Chip>
                    ) : null}
                  </div>
                </ItemFooter>
              </ItemContent>
              <ItemActions>
                <Button
                  onClick={() => setSelectedId(workflow.id)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  View
                </Button>
              </ItemActions>
            </Item>
          ))}
        </div>
      )}

      <Dialog
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedId(null);
            mutate.reset();
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.title ?? "Workflow"}</DialogTitle>
            <DialogDescription>
              {selected
                ? `${agentName(selected.agentId)} · ${selected.status}`
                : "Durable workflow state"}
            </DialogDescription>
          </DialogHeader>

          {detail.isPending ? (
            <p className="text-sm text-muted-foreground">Loading workflow…</p>
          ) : detail.error ? (
            <p className="text-sm text-destructive" role="alert">
              {detail.error.message}
            </p>
          ) : detail.data ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                {detail.data.workflow.steps.map((step) => (
                  <div
                    className="rounded-lg border border-border p-3"
                    key={step.key}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-sm">{step.key}</p>
                      <div className="flex flex-wrap gap-1.5">
                        <Chip>{step.status}</Chip>
                        <Chip>attempt {step.attempts}</Chip>
                        {step.provider ? <Chip>{step.provider}</Chip> : null}
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {step.instruction}
                    </p>
                    {step.waitUntil ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Wakes {relativeTime(step.waitUntil)}
                      </p>
                    ) : null}
                    {step.failureReason ? (
                      <p className="mt-2 text-xs text-destructive">
                        {step.failureReason}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>

              {detail.data.assets.length > 0 ? (
                <div>
                  <p className="mb-2 font-medium text-sm">Assets</p>
                  <div className="flex flex-col gap-2">
                    {detail.data.assets.map((asset) => (
                      <div
                        className="rounded-lg border border-border p-3 text-sm"
                        key={asset.id}
                      >
                        <div className="flex flex-wrap gap-1.5">
                          <Chip>{asset.stepKey}</Chip>
                          <Chip>{asset.direction}</Chip>
                          <Chip>{asset.mediaKind}</Chip>
                        </div>
                        <p className="mt-2 break-all text-muted-foreground">
                          {asset.label ?? asset.ref}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {mutate.error ? (
            <p className="text-sm text-destructive" role="alert">
              {mutate.error.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              onClick={() => setSelectedId(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Close
            </Button>
            {selected?.status === "active" ? (
              <Button
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate({ id: selected.id, action: "pause" })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Pause
              </Button>
            ) : null}
            {selected?.status === "paused" ? (
              <Button
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate({ id: selected.id, action: "resume" })
                }
                size="sm"
                type="button"
                variant="outline"
              >
                Resume
              </Button>
            ) : null}
            {selected &&
            (selected.status === "active" || selected.status === "paused") ? (
              <Button
                disabled={mutate.isPending}
                onClick={() =>
                  mutate.mutate(
                    { id: selected.id, action: "cancel" },
                    { onSuccess: () => setSelectedId(null) },
                  )
                }
                size="sm"
                type="button"
                variant="destructive"
              >
                Cancel workflow
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageSection>
  );
}
