import { useMemories } from "@copilotkit/react-core/v2";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageSection } from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { diffMemoryLines } from "@/lib/memory/diff";
import {
  type MemoryHistoryRecord,
  type MemoryKind,
  loadMemoryHistory,
} from "@/lib/memory/history";

const MEMORY_LIMIT = 8_192;

function short(value: string, limit = 100) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

export function MemorySettings() {
  const {
    memories,
    isLoading,
    isAvailable,
    error,
    realtimeStatus,
    addMemory,
    updateMemory,
    removeMemory,
  } = useMemories();
  const [history, setHistory] = useState<MemoryHistoryRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [newContent, setNewContent] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("topical");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retiredForDiff, setRetiredForDiff] = useState("");
  const [currentForDiff, setCurrentForDiff] = useState("");

  const reloadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory(await loadMemoryHistory());
    } catch (failure) {
      setProblem(
        failure instanceof Error
          ? failure.message
          : "Could not load memory history.",
      );
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAvailable) void reloadHistory();
  }, [isAvailable, reloadHistory]);

  const retired = history.filter(
    (memory) => memory.invalidatedAt !== null && memory.scope === "user",
  );
  const selectedRetired = retired.find(
    (memory) => memory.id === retiredForDiff,
  );
  const selectedCurrent = memories.find(
    (memory) => memory.id === currentForDiff,
  );
  const diff = useMemo(() => {
    if (!selectedRetired || !selectedCurrent) return [];
    const occurrences = new Map<string, number>();
    return diffMemoryLines(
      selectedRetired.content,
      selectedCurrent.content,
    ).map((line) => {
      const identity = `${line.type}:\u0000${line.text}`;
      const occurrence = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, occurrence);
      return {
        ...line,
        key: `${identity}:\u0000${occurrence}`,
      };
    });
  }, [selectedRetired, selectedCurrent]);

  const mutate = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id);
    setProblem(null);
    try {
      await action();
      await reloadHistory();
    } catch (failure) {
      setProblem(
        failure instanceof Error ? failure.message : "Memory operation failed.",
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageSection
      description="Durable Intelligence memory for your account. Memories are scoped to you, not shared project-wide."
      title="Memory"
    >
      {!isAvailable ? (
        <p className="mt-4 text-sm text-muted-foreground">
          Memory is not available for this deployment.
        </p>
      ) : isLoading ? null : (
        <div className="mt-4 grid gap-5">
          <div className="grid gap-2 rounded-md border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Add memory</p>
                <p className="text-xs text-muted-foreground">
                  Topical = durable facts, episodic = events, operational =
                  working preferences.
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {realtimeStatus === "connected"
                  ? "Live"
                  : realtimeStatus === "connecting"
                    ? "Connecting…"
                    : "Snapshot only"}
              </span>
            </div>
            <select
              aria-label="Memory kind"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              onChange={(event) => setNewKind(event.target.value as MemoryKind)}
              value={newKind}
            >
              <option value="topical">Topical</option>
              <option value="episodic">Episodic</option>
              <option value="operational">Operational</option>
            </select>
            <Textarea
              aria-label="New memory"
              className="min-h-24"
              onChange={(event) => setNewContent(event.target.value)}
              placeholder="A stable fact or preference OpenBot should remember."
              value={newContent}
            />
            <div className="flex items-center justify-between gap-3">
              <span
                className={
                  newContent.length > MEMORY_LIMIT
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {newContent.length} of {MEMORY_LIMIT} characters
              </span>
              <Button
                disabled={
                  !newContent.trim() ||
                  newContent.length > MEMORY_LIMIT ||
                  busyId !== null
                }
                onClick={() =>
                  void mutate("new", async () => {
                    await addMemory({
                      content: newContent.trim(),
                      kind: newKind,
                      scope: "user",
                    });
                    setNewContent("");
                  })
                }
                size="sm"
              >
                {busyId === "new" ? "Saving…" : "Remember"}
              </Button>
            </div>
          </div>

          <div className="grid gap-2">
            <div>
              <p className="text-sm font-medium">Current memories</p>
              <p className="text-xs text-muted-foreground">
                Edit supersedes the old memory instead of mutating it in place.
                Forget retires it non-destructively.
              </p>
            </div>
            {memories.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No memories saved yet.
              </p>
            ) : (
              memories.map((memory) => (
                <div
                  className="grid gap-2 rounded-md border border-border p-3"
                  key={memory.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs uppercase text-muted-foreground">
                      {memory.kind}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        disabled={busyId !== null}
                        onClick={() => {
                          setEditingId(memory.id);
                          setEditingContent(memory.content);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        Edit
                      </Button>
                      <Button
                        disabled={busyId !== null}
                        onClick={() =>
                          void mutate(memory.id, () => removeMemory(memory.id))
                        }
                        size="sm"
                        variant="outline"
                      >
                        {busyId === memory.id ? "Working…" : "Forget"}
                      </Button>
                    </div>
                  </div>
                  {editingId === memory.id ? (
                    <>
                      <Textarea
                        aria-label="Edit memory"
                        className="min-h-24"
                        onChange={(event) =>
                          setEditingContent(event.target.value)
                        }
                        value={editingContent}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          onClick={() => setEditingId(null)}
                          size="sm"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={
                            !editingContent.trim() ||
                            editingContent.length > MEMORY_LIMIT ||
                            busyId !== null
                          }
                          onClick={() =>
                            void mutate(memory.id, async () => {
                              await updateMemory(memory.id, {
                                content: editingContent.trim(),
                                kind: memory.kind,
                                scope: "user",
                                sourceThreadIds: memory.sourceThreadIds,
                              });
                              setEditingId(null);
                            })
                          }
                          size="sm"
                        >
                          Save edit
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm">
                      {memory.content}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="grid gap-2">
            <div>
              <p className="text-sm font-medium">History</p>
              <p className="text-xs text-muted-foreground">
                Retired memories remain inspectable. Restore creates a new
                memory; it never guesses which active memory to overwrite.
              </p>
            </div>
            {historyLoading ? (
              <p className="text-sm text-muted-foreground">Loading history…</p>
            ) : retired.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No retired memories yet.
              </p>
            ) : (
              retired.map((memory) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                  key={memory.id}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{short(memory.content)}</p>
                    <p className="text-xs text-muted-foreground">
                      {memory.kind} · retired{" "}
                      {memory.invalidatedAt
                        ? new Date(memory.invalidatedAt).toLocaleString()
                        : ""}
                    </p>
                  </div>
                  <Button
                    disabled={busyId !== null}
                    onClick={() =>
                      void mutate(memory.id, () =>
                        addMemory({
                          content: memory.content,
                          kind: memory.kind,
                          scope: "user",
                          sourceThreadIds: memory.sourceThreadIds,
                        }),
                      )
                    }
                    size="sm"
                    variant="outline"
                  >
                    {busyId === memory.id ? "Restoring…" : "Restore"}
                  </Button>
                </div>
              ))
            )}
          </div>

          {retired.length > 0 && memories.length > 0 ? (
            <div className="grid gap-2">
              <div>
                <p className="text-sm font-medium">Compare memories</p>
                <p className="text-xs text-muted-foreground">
                  Choose both sides explicitly; OpenBot does not infer revision
                  lineage that Intelligence does not expose.
                </p>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <select
                  aria-label="Historical memory"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  onChange={(event) => setRetiredForDiff(event.target.value)}
                  value={retiredForDiff}
                >
                  <option value="">Historical memory…</option>
                  {retired.map((memory) => (
                    <option key={memory.id} value={memory.id}>
                      {memory.kind}: {short(memory.content, 60)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Current memory"
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  onChange={(event) => setCurrentForDiff(event.target.value)}
                  value={currentForDiff}
                >
                  <option value="">Current memory…</option>
                  {memories.map((memory) => (
                    <option key={memory.id} value={memory.id}>
                      {memory.kind}: {short(memory.content, 60)}
                    </option>
                  ))}
                </select>
              </div>
              {selectedRetired && selectedCurrent ? (
                <div className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
                  {diff.map((line) => (
                    <div
                      className={
                        line.type === "added"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : line.type === "removed"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                      key={line.key}
                    >
                      <span className="mr-2 select-none">
                        {line.type === "added"
                          ? "+"
                          : line.type === "removed"
                            ? "-"
                            : " "}
                      </span>
                      <span className="whitespace-pre-wrap">{line.text}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {error || problem ? (
            <p className="text-sm text-destructive" role="alert">
              {problem ?? error?.message}
            </p>
          ) : null}
        </div>
      )}
    </PageSection>
  );
}
