import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import {
  computerMetricsQueryOptions,
  computerStatusQueryOptions,
} from "@/lib/computers/queries";

function stateLabel(state: "ready" | "starting" | "absent" | "unreachable") {
  switch (state) {
    case "ready":
      return "Running";
    case "starting":
      return "Starting";
    case "absent":
      return "Stopped";
    case "unreachable":
      return "Unavailable";
  }
}

function formatBytes(bytes: number | null) {
  if (bytes === null) return "Not reported";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Lifecycle controls for exactly one Agent's computer.
 *
 * This panel deliberately uses the existing governed computer routes rather than talking to a
 * supervisor or agent-computer directly. The server is where Agent ownership, audit, policy and
 * reset cleanup live, so the browser cannot accidentally grow a second management boundary.
 */
export function ComputerPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const status = useQuery(computerStatusQueryOptions(agentId));
  const metrics = useQuery({
    ...computerMetricsQueryOptions(agentId),
    enabled: status.data?.state === "ready",
  });
  const lifecycle = useMutation(setComputerStateMutationOptions(queryClient));
  const [confirmReset, setConfirmReset] = useState(false);

  if (status.isPending) return null;
  if (status.error || !status.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {status.error?.message ?? "Could not read this Agent's computer."}
      </p>
    );
  }

  const state = status.data.state;
  const busy = lifecycle.isPending;
  const action = lifecycle.variables?.action;

  const run = (next: "start" | "restart" | "stop" | "reset") => {
    lifecycle.mutate(
      { botId: agentId, action: next },
      {
        onSuccess: () => {
          if (next === "reset") setConfirmReset(false);
        },
      },
    );
  };

  return (
    <div className="grid gap-5">
      <div className="rounded-lg border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">{stateLabel(state)}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {state === "ready"
                ? "The computer is ready for browser, file and command work."
                : state === "starting"
                  ? "The computer is coming online."
                  : state === "absent"
                    ? "No computer runtime is active. Saved state is kept until Reset."
                    : status.data.reason ?? "The computer provider cannot be reached."}
            </p>
          </div>
          <Button
            disabled={status.isFetching || busy}
            onClick={() => void status.refetch()}
            size="sm"
            variant="ghost"
          >
            {status.isFetching ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </div>

      {state === "ready" ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">CPU</p>
            <p className="mt-1 font-medium">
              {metrics.data?.metrics?.cpuPercent === null ||
              metrics.data?.metrics?.cpuPercent === undefined
                ? "Not reported"
                : `${metrics.data.metrics.cpuPercent.toFixed(1)}%`}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Memory</p>
            <p className="mt-1 font-medium">
              {metrics.data?.metrics
                ? `${formatBytes(metrics.data.metrics.memoryUsedBytes)}${
                    metrics.data.metrics.memoryLimitBytes === null
                      ? ""
                      : ` / ${formatBytes(
                          metrics.data.metrics.memoryLimitBytes,
                        )}`
                  }`
                : "Loading…"}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Workspace disk</p>
            <p className="mt-1 font-medium">
              {metrics.data?.metrics
                ? `${formatBytes(metrics.data.metrics.workspaceUsedBytes)}${
                    metrics.data.metrics.workspaceTotalBytes === null
                      ? ""
                      : ` / ${formatBytes(
                          metrics.data.metrics.workspaceTotalBytes,
                        )}`
                  }`
                : "Loading…"}
            </p>
          </div>
          {metrics.error ? (
            <p className="text-xs text-destructive sm:col-span-3" role="alert">
              {metrics.error.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {status.data.canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || state === "ready" || state === "starting"}
            onClick={() => run("start")}
            size="sm"
          >
            {busy && action === "start" ? "Starting…" : "Start"}
          </Button>
          <Button
            disabled={busy || state !== "ready"}
            onClick={() => run("restart")}
            size="sm"
            variant="outline"
          >
            {busy && action === "restart" ? "Restarting…" : "Restart"}
          </Button>
          <Button
            disabled={busy || (state !== "ready" && state !== "starting")}
            onClick={() => run("stop")}
            size="sm"
            variant="outline"
          >
            {busy && action === "stop" ? "Stopping…" : "Stop"}
          </Button>
          <Button
            disabled={busy}
            onClick={() => setConfirmReset(true)}
            size="sm"
            variant="destructive"
          >
            Reset
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          You can use this Agent, but only its owner or a deployment
          administrator can change its computer lifecycle.
        </p>
      )}

      <div className="grid gap-1 text-xs text-muted-foreground">
        <p>
          <strong>Stop</strong> and <strong>Restart</strong> keep the saved
          browser profile and workspace.
        </p>
        <p>
          <strong>Reset</strong> deletes the saved browser profile and signs
          the Agent out of sites. Workspace files are kept.
        </p>
      </div>

      {lifecycle.error ? (
        <p className="text-sm text-destructive" role="alert">
          {lifecycle.error.message}
        </p>
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmReset(false);
        }}
        open={confirmReset}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset this Agent&apos;s computer?</DialogTitle>
            <DialogDescription>
              This deletes its saved browser profile, including site logins and
              browser storage. Workspace files remain. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={() => setConfirmReset(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => run("reset")}
              size="sm"
              variant="destructive"
            >
              {busy && action === "reset" ? "Resetting…" : "Reset computer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
