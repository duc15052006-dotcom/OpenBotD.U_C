import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  saveAgentMemoryMutationOptions,
  undoAgentMemoryMutationOptions,
} from "@/lib/agents/mutations";
import {
  AGENT_MEMORY_LIMIT,
  type AgentMemoryDiff,
  agentMemoryHistoryQueryOptions,
  agentMemoryQueryOptions,
  loadAgentMemoryDiff,
} from "@/lib/agents/queries";

export function MemoryPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const memory = useQuery(agentMemoryQueryOptions(agentId));
  const history = useQuery(agentMemoryHistoryQueryOptions(agentId));
  const save = useMutation(saveAgentMemoryMutationOptions(queryClient));
  const undo = useMutation(undoAgentMemoryMutationOptions(queryClient));
  const [draft, setDraft] = useState<string | null>(null);
  const [diff, setDiff] = useState<AgentMemoryDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState<string | null>(null);

  useEffect(() => {
    if (memory.data !== undefined && draft === null) {
      setDraft(memory.data.memory);
    }
  }, [memory.data, draft]);

  if (memory.isPending || history.isPending) return null;
  if (memory.error || history.error || !memory.data || !history.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {memory.error?.message ??
          history.error?.message ??
          "Could not load Agent memory."}
      </p>
    );
  }

  const text = draft ?? memory.data.memory;
  const over = text.length > AGENT_MEMORY_LIMIT;
  const unchanged = text === memory.data.memory;
  const busy = save.isPending || undo.isPending;

  const inspect = async (revisionId: string) => {
    setLoadingDiff(revisionId);
    setDiffError(null);
    try {
      setDiff(await loadAgentMemoryDiff(agentId, revisionId));
    } catch (error) {
      setDiffError(
        error instanceof Error ? error.message : "Could not compare revision.",
      );
    } finally {
      setLoadingDiff(null);
    }
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          Keep stable facts and working context this coworker should remember.
          Memory is reference data, never instruction text.
        </p>
        <Textarea
          aria-label="Agent memory"
          className="min-h-48"
          disabled={!memory.data.canManage || busy}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add stable context this coworker should remember across conversations."
          value={text}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className={
              over
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {text.length} of {AGENT_MEMORY_LIMIT} characters
          </p>
          {memory.data.canManage ? (
            <div className="flex items-center gap-3">
              {save.error ? (
                <span className="text-xs text-destructive" role="alert">
                  {save.error.message}
                </span>
              ) : null}
              <Button
                disabled={busy || over || unchanged}
                onClick={() =>
                  save.mutate(
                    {
                      agentId,
                      memory: text,
                      baseRevisionId: memory.data.revisionId,
                    },
                    {
                      onSuccess: (saved) => {
                        setDraft(saved.memory);
                        setDiff(null);
                      },
                    },
                  )
                }
                size="sm"
              >
                {save.isPending ? "Saving…" : "Save memory"}
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              You can view this memory but cannot change it.
            </span>
          )}
        </div>
      </div>

      <div className="grid gap-2">
        <div>
          <h3 className="text-sm font-medium">History</h3>
          <p className="text-xs text-muted-foreground">
            Save and Undo both create a new revision. Up to 20 recent revisions
            are kept.
          </p>
        </div>
        {history.data.revisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No memory revisions yet.
          </p>
        ) : (
          <div className="grid gap-2">
            {history.data.revisions.map((revision) => {
              const current = revision.id === memory.data.revisionId;
              return (
                <div
                  className="rounded-md border border-border px-3 py-2"
                  key={revision.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {current
                          ? "Current"
                          : revision.kind === "undo"
                            ? "Restored revision"
                            : "Saved revision"}
                        {" · "}
                        {new Date(revision.createdAt).toLocaleString()}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {revision.characters} characters
                        {revision.preview ? ` · ${revision.preview}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={loadingDiff !== null}
                        onClick={() => void inspect(revision.id)}
                        size="sm"
                        variant="outline"
                      >
                        {loadingDiff === revision.id ? "Comparing…" : "Diff"}
                      </Button>
                      {memory.data.canManage && !current ? (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            undo.mutate(
                              {
                                agentId,
                                revisionId: revision.id,
                                baseRevisionId: memory.data.revisionId,
                              },
                              {
                                onSuccess: (restored) => {
                                  setDraft(restored.memory);
                                  setDiff(null);
                                },
                              },
                            )
                          }
                          size="sm"
                          variant="outline"
                        >
                          {undo.isPending ? "Restoring…" : "Restore"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {undo.error ? (
          <p className="text-xs text-destructive" role="alert">
            {undo.error.message}
          </p>
        ) : null}
        {diffError ? (
          <p className="text-xs text-destructive" role="alert">
            {diffError}
          </p>
        ) : null}
      </div>

      {diff ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Revision → current diff</h3>
          <div className="max-h-64 overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">
            {diff.lines.map((line, index) => (
              <div
                className={
                  line.type === "added"
                    ? "text-emerald-700 dark:text-emerald-400"
                    : line.type === "removed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                }
                key={`${index}-${line.type}`}
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
        </div>
      ) : null}
    </div>
  );
}
