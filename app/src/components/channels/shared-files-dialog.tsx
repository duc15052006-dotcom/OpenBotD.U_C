import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { attachmentUrl } from "@/lib/channels/attachments";
import { channelSharedFilesQueryOptions } from "@/lib/channels/shared-files";

export function SharedFilesDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const files = useQuery({
    ...channelSharedFilesQueryOptions(channelId),
    enabled: open,
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Shared files</DialogTitle>
          <DialogDescription>
            Files that have already been sent in this conversation. Unsent
            drafts never appear here.
          </DialogDescription>
        </DialogHeader>

        {files.isError ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {files.error.message}
          </p>
        ) : files.isPending ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            Loading…
          </p>
        ) : files.data.attachments.length === 0 ? (
          <p className="py-6 text-center text-muted-foreground text-sm">
            No files have been shared in this conversation yet.
          </p>
        ) : (
          <div className="max-h-[55svh] overflow-y-auto rounded-md border border-border">
            {files.data.attachments.map((file) => (
              <a
                className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm hover:bg-muted/60"
                href={attachmentUrl(file.id)}
                key={file.id}
                rel="noreferrer"
                target="_blank"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {file.name}
                  </span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {file.mimeType} · {formatBytes(file.sizeBytes)}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {new Date(file.attachedAt).toLocaleString()}
                </span>
              </a>
            ))}
          </div>
        )}
        {!files.isPending && !files.isError && files.data?.truncated ? (
          <p className="text-muted-foreground text-xs">
            Showing the 100 most recently shared files.
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
