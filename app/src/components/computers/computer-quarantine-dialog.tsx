import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteQuarantinedDownloadMutationOptions } from "@/lib/computers/mutations";
import {
  quarantineQueryOptions,
  type QuarantineEntry,
} from "@/lib/computers/queries";

export function ComputerQuarantineDialog({
  botId,
  botName,
  open,
  onOpenChange,
}: {
  botId: string;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const quarantine = useQuery({
    ...quarantineQueryOptions(botId),
    enabled: open,
  });
  const remove = useMutation(
    deleteQuarantinedDownloadMutationOptions(queryClient),
  );
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setConfirming(null);
  }, [open]);

  const problem =
    quarantine.error instanceof Error
      ? quarantine.error.message
      : remove.error instanceof Error
        ? remove.error.message
        : null;

  const deleteEntry = (entry: QuarantineEntry) => {
    if (confirming !== entry.id) {
      setConfirming(entry.id);
      return;
    }
    remove.mutate(
      { botId, id: entry.id },
      { onSuccess: () => setConfirming(null) },
    );
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85svh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{botName}&apos;s quarantine</DialogTitle>
          <DialogDescription>
            Browser downloads stay isolated here. They are not scanned,
            executable, or exportable to Windows from this screen.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <strong>Untrusted files.</strong> Opening this list reads metadata
          only. File bytes never enter the browser UI or the assistant context.
        </div>

        {problem ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {problem}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
          {quarantine.isPending ? (
            <p className="p-4 text-muted-foreground text-sm">Loading…</p>
          ) : (quarantine.data?.downloads.length ?? 0) === 0 ? (
            <p className="p-4 text-muted-foreground text-sm">
              No quarantined downloads.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {quarantine.data?.downloads.map((entry) => (
                <div className="space-y-3 p-4" key={entry.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="break-all font-medium text-sm"
                        title={entry.originalName}
                      >
                        {entry.originalName}
                      </p>
                      <p className="mt-1 text-muted-foreground text-xs">
                        {formatBytes(entry.bytes)} · downloaded{" "}
                        {new Date(entry.savedAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-amber-700 text-xs dark:text-amber-300">
                      Not scanned
                    </span>
                  </div>

                  <dl className="grid gap-2 text-xs sm:grid-cols-[90px_minmax(0,1fr)]">
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="break-all" title={entry.sourceUrl}>
                      {entry.sourceUrl}
                    </dd>
                    <dt className="text-muted-foreground">SHA-256</dt>
                    <dd className="break-all font-mono">{entry.sha256}</dd>
                  </dl>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {confirming === entry.id ? (
                      <span className="mr-auto text-destructive text-xs">
                        Delete this quarantined file permanently?
                      </span>
                    ) : null}
                    {confirming === entry.id ? (
                      <Button
                        disabled={remove.isPending}
                        onClick={() => setConfirming(null)}
                        size="sm"
                        variant="outline"
                      >
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      disabled={remove.isPending}
                      onClick={() => deleteEntry(entry)}
                      size="sm"
                      variant={
                        confirming === entry.id ? "destructive" : "outline"
                      }
                    >
                      {remove.isPending && remove.variables?.id === entry.id
                        ? "Deleting…"
                        : confirming === entry.id
                          ? "Confirm delete"
                          : "Delete"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <span className="mr-auto text-muted-foreground text-xs">
            Export remains disabled until malware scanning and native approval
            are wired.
          </span>
          <Button
            onClick={() => onOpenChange(false)}
            size="sm"
            variant="outline"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
