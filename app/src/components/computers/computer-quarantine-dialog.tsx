import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  approveQuarantinedDownloadMutationOptions,
  exportQuarantinedDownloadMutationOptions,
  scanQuarantinedDownloadMutationOptions,
} from "@/lib/computers/mutations";
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
  const scan = useMutation(scanQuarantinedDownloadMutationOptions(queryClient));
  const approve = useMutation(
    approveQuarantinedDownloadMutationOptions(queryClient),
  );
  const exportFile = useMutation(
    exportQuarantinedDownloadMutationOptions(queryClient),
  );

  const problem =
    quarantine.error instanceof Error
      ? quarantine.error.message
      : scan.error instanceof Error
        ? scan.error.message
        : approve.error instanceof Error
          ? approve.error.message
          : exportFile.error instanceof Error
            ? exportFile.error.message
            : null;

  const busyId =
    (scan.isPending ? scan.variables?.id : null) ??
    (approve.isPending ? approve.variables?.id : null) ??
    (exportFile.isPending ? exportFile.variables?.id : null) ??
    null;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85svh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{botName}&apos;s quarantine</DialogTitle>
          <DialogDescription>
            Browser downloads stay isolated until they pass malware scanning,
            are explicitly approved, and you choose a Windows destination.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <strong>Untrusted files.</strong> Export uses a native Save As dialog,
          verifies the approved SHA-256 and byte size again, and never
          auto-opens or runs the file.
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
                        {formatBytes(entry.sizeBytes)} · downloaded{" "}
                        {new Date(entry.savedAt).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge entry={entry} />
                  </div>

                  <dl className="grid gap-2 text-xs sm:grid-cols-[90px_minmax(0,1fr)]">
                    <dt className="text-muted-foreground">Source</dt>
                    <dd className="break-all" title={entry.sourceUrl}>
                      {entry.sourceUrl}
                    </dd>
                    <dt className="text-muted-foreground">SHA-256</dt>
                    <dd className="break-all font-mono">{entry.sha256}</dd>
                    {entry.scan ? (
                      <>
                        <dt className="text-muted-foreground">Scanner</dt>
                        <dd>
                          {entry.scan.scanner} · {entry.scan.detail}
                        </dd>
                      </>
                    ) : null}
                  </dl>

                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {entry.status === "pending" ||
                    entry.status === "blocked" ||
                    entry.status === "scan_failed" ? (
                      <Button
                        disabled={busyId !== null}
                        onClick={() => scan.mutate({ botId, id: entry.id })}
                        size="sm"
                        variant="outline"
                      >
                        {scan.isPending && scan.variables?.id === entry.id
                          ? "Scanning…"
                          : entry.status === "pending"
                            ? "Scan"
                            : "Rescan"}
                      </Button>
                    ) : null}

                    {entry.status === "clean" ? (
                      <Button
                        disabled={busyId !== null}
                        onClick={() => approve.mutate({ botId, id: entry.id })}
                        size="sm"
                        variant="outline"
                      >
                        {approve.isPending && approve.variables?.id === entry.id
                          ? "Approving…"
                          : "Approve export"}
                      </Button>
                    ) : null}

                    {entry.status === "approved" ? (
                      <Button
                        disabled={busyId !== null}
                        onClick={() =>
                          exportFile.mutate({ botId, id: entry.id })
                        }
                        size="sm"
                      >
                        {exportFile.isPending &&
                        exportFile.variables?.id === entry.id
                          ? "Waiting for Save As…"
                          : "Export to Windows…"}
                      </Button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <span className="mr-auto text-muted-foreground text-xs">
            A failed scan is never treated as clean. Export requires native
            confirmation every time.
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

function StatusBadge({ entry }: { entry: QuarantineEntry }) {
  const label = {
    pending: "Needs scan",
    clean: "Clean · approval needed",
    blocked: "Blocked",
    scan_failed: "Scan failed",
    approved: "Approved · not exported",
    released: "Exported",
  }[entry.status];

  const tone =
    entry.status === "blocked" || entry.status === "scan_failed"
      ? "border-destructive/40 text-destructive"
      : entry.status === "clean" ||
          entry.status === "approved" ||
          entry.status === "released"
        ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
        : "border-amber-500/40 text-amber-700 dark:text-amber-300";

  return (
    <span className={`rounded-full border px-2 py-0.5 text-xs ${tone}`}>
      {label}
    </span>
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
