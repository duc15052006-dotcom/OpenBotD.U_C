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
import { Textarea } from "@/components/ui/textarea";
import {
  type ComputerWorkspaceEntry,
  listComputerFiles,
  readComputerFile,
  writeComputerFile,
} from "@/lib/computers/files";

export function ComputerFilesDialog({
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
  const [entries, setEntries] = useState<ComputerWorkspaceEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [contents, setContents] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [listingTruncated, setListingTruncated] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedPath(null);
    setContents("");
    setTruncated(false);
    setProblem(null);
    setLoading(true);
    void listComputerFiles(botId)
      .then((listing) => {
        setEntries(
          [...listing.entries].sort((left, right) => {
            if (left.kind !== right.kind)
              return left.kind === "folder" ? -1 : 1;
            return left.path.localeCompare(right.path);
          }),
        );
        setListingTruncated(listing.truncated);
      })
      .catch((error: unknown) =>
        setProblem(
          error instanceof Error
            ? error.message
            : "The files could not be loaded.",
        ),
      )
      .finally(() => setLoading(false));
  }, [botId, open]);

  const openFile = async (path: string) => {
    setLoading(true);
    setProblem(null);
    try {
      const file = await readComputerFile(botId, path);
      setSelectedPath(file.path);
      setContents(file.text);
      setTruncated(file.truncated);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "The file could not be read.",
      );
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!selectedPath || truncated) return;
    setSaving(true);
    setProblem(null);
    try {
      await writeComputerFile(botId, selectedPath, contents);
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "The file could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85svh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{botName}&apos;s files</DialogTitle>
          <DialogDescription>
            Text files inside this Bot&apos;s persistent workspace. Reads and
            saves still pass through the computer policy and audit boundary.
          </DialogDescription>
        </DialogHeader>

        {problem ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {problem}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.6fr)]">
          <div className="min-h-0 overflow-y-auto rounded-md border border-border">
            <div className="sticky top-0 border-b border-border bg-background px-3 py-2 font-medium text-sm">
              /workspace
            </div>
            {loading && entries.length === 0 ? (
              <p className="p-3 text-muted-foreground text-sm">Loading…</p>
            ) : entries.length === 0 ? (
              <p className="p-3 text-muted-foreground text-sm">No files yet.</p>
            ) : (
              <div className="p-1">
                {entries.map((entry) =>
                  entry.kind === "folder" ? (
                    <div
                      className="px-2 py-1.5 text-muted-foreground text-sm"
                      key={entry.path}
                      title={entry.path}
                    >
                      📁 {entry.path}
                    </div>
                  ) : (
                    <button
                      className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
                      disabled={loading}
                      key={entry.path}
                      onClick={() => void openFile(entry.path)}
                      type="button"
                    >
                      <span className="min-w-0 truncate">📄 {entry.path}</span>
                      {entry.bytes !== undefined ? (
                        <span className="shrink-0 text-muted-foreground text-xs">
                          {formatBytes(entry.bytes)}
                        </span>
                      ) : null}
                    </button>
                  ),
                )}
              </div>
            )}
            {listingTruncated ? (
              <p className="border-t border-border px-3 py-2 text-amber-700 text-xs dark:text-amber-300">
                The workspace has more entries than this bounded listing can
                show.
              </p>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-col gap-2">
            {selectedPath ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p
                    className="truncate font-medium text-sm"
                    title={selectedPath}
                  >
                    {selectedPath}
                  </p>
                  {truncated ? (
                    <span className="shrink-0 text-amber-700 text-xs dark:text-amber-300">
                      Preview truncated
                    </span>
                  ) : null}
                </div>
                <Textarea
                  className="min-h-[320px] flex-1 resize-none font-mono text-xs"
                  onChange={(event) => setContents(event.target.value)}
                  readOnly={truncated}
                  value={contents}
                />
                {truncated ? (
                  <p className="text-muted-foreground text-xs">
                    Saving is disabled because only the first part of this file
                    was returned. This prevents a preview from overwriting the
                    full file.
                  </p>
                ) : null}
              </>
            ) : (
              <div className="flex min-h-[320px] flex-1 items-center justify-center rounded-md border border-dashed border-border p-6 text-center text-muted-foreground text-sm">
                Choose a text file to preview or edit it.
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
            Close
          </Button>
          <Button
            disabled={!selectedPath || truncated || saving || loading}
            onClick={() => void save()}
            size="sm"
          >
            {saving ? "Saving…" : "Save file"}
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
