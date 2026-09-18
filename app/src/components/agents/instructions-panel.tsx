import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { saveAgentInstructionsMutationOptions } from "@/lib/agents/mutations";
import {
  AGENT_INSTRUCTIONS_LIMIT,
  agentInstructionsQueryOptions,
} from "@/lib/agents/queries";
import { queryClient } from "@/query-client";

export function InstructionsPanel({ agentId }: { agentId: string }) {
  const stored = useQuery(agentInstructionsQueryOptions(agentId));
  const save = useMutation(saveAgentInstructionsMutationOptions(queryClient));
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (stored.data !== undefined && draft === null) {
      setDraft(stored.data.instructions);
    }
  }, [stored.data, draft]);

  if (stored.isPending) return null;
  if (stored.error || !stored.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {stored.error?.message ?? "Could not load Agent instructions."}
      </p>
    );
  }

  const text = draft ?? stored.data.instructions;
  const over = text.trim().length > AGENT_INSTRUCTIONS_LIMIT;
  const unchanged = text === stored.data.instructions;

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <Textarea
          aria-label="Agent instructions"
          className="min-h-56"
          disabled={!stored.data.canManage || save.isPending}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
          placeholder="Add durable instructions that apply whenever this Agent runs."
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
            {text.trim().length} of {AGENT_INSTRUCTIONS_LIMIT} characters
          </p>
          {stored.data.canManage ? (
            <div className="flex items-center gap-3">
              {save.error ? (
                <span className="text-xs text-destructive" role="alert">
                  {save.error.message}
                </span>
              ) : saved ? (
                <span className="text-xs text-muted-foreground">Saved</span>
              ) : null}
              <Button
                disabled={save.isPending || over || unchanged}
                onClick={() => {
                  setSaved(false);
                  save.mutate(
                    { agentId, instructions: text },
                    {
                      onSuccess: (value) => {
                        setDraft(value.instructions);
                        setSaved(true);
                      },
                    },
                  );
                }}
                size="sm"
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              You can view these instructions but cannot change them.
            </span>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        These instructions apply only to this coworker. Your standing
        instructions in Settings still apply across all coworkers.
      </p>
    </div>
  );
}
