import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import {
  removeAgentKnowledgeMutationOptions,
  uploadAgentKnowledgeMutationOptions,
} from "@/lib/agents/mutations";
import { agentKnowledgeQueryOptions } from "@/lib/agents/queries";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function KnowledgePanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const knowledge = useQuery(agentKnowledgeQueryOptions(agentId));
  const upload = useMutation(uploadAgentKnowledgeMutationOptions(queryClient));
  const remove = useMutation(removeAgentKnowledgeMutationOptions(queryClient));

  if (knowledge.isPending) return null;
  if (knowledge.error || !knowledge.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {knowledge.error?.message ?? "Could not load Agent knowledge."}
      </p>
    );
  }

  const error = upload.error ?? remove.error;
  const full =
    knowledge.data.documents.length >= knowledge.data.limits.documents;
  const totalCharacters = knowledge.data.documents.reduce(
    (sum, document) => sum + document.characters,
    0,
  );

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <p className="text-sm text-muted-foreground">
          Upload bounded reference files that are available whenever this
          coworker runs. File contents are treated as untrusted reference data,
          never as instructions.
        </p>
        <Input
          accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
          aria-label="Upload knowledge file"
          disabled={upload.isPending || remove.isPending || full}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) upload.mutate({ agentId, file });
            event.currentTarget.value = "";
          }}
          type="file"
        />
        <p className="text-xs text-muted-foreground">
          {knowledge.data.documents.length} of {knowledge.data.limits.documents}{" "}
          files · {totalCharacters.toLocaleString()} of{" "}
          {knowledge.data.limits.totalCharacters.toLocaleString()} characters ·{" "}
          {formatBytes(knowledge.data.limits.fileBytes)} maximum per file
        </p>
      </div>

      {knowledge.data.documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No uploaded knowledge yet.
        </p>
      ) : (
        <div className="grid gap-2">
          {knowledge.data.documents.map((document) => (
            <Item key={document.id} variant="muted">
              <ItemContent>
                <ItemTitle>{document.name}</ItemTitle>
                <ItemDescription>
                  {formatBytes(document.sizeBytes)} ·{" "}
                  {document.characters.toLocaleString()} characters
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={upload.isPending || remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      agentId,
                      documentId: document.id,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Remove
                </Button>
              </ItemActions>
            </Item>
          ))}
        </div>
      )}

      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
