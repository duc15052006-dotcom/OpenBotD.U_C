import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { setPluginGrantMutationOptions } from "@/lib/plugins/mutations";
import {
  agentPluginsQueryOptions,
  pluginsPageQueryOptions,
} from "@/lib/plugins/queries";

/**
 * Agent-centric view of the existing skill grant model.
 *
 * Skills are not copied into the Agent row. The grant remains the authority, so changing it here
 * changes the same row used by the Skills page and by runtime skill selection.
 */
export function SkillsPanel({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const catalogue = useQuery(pluginsPageQueryOptions());
  const granted = useQuery(agentPluginsQueryOptions(agentId));
  const change = useMutation(setPluginGrantMutationOptions(queryClient));

  if (catalogue.isPending || granted.isPending) return null;
  const problem = catalogue.error ?? granted.error;
  if (problem || !catalogue.data || !granted.data) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {problem?.message ?? "Skills could not be loaded for this Agent."}
      </p>
    );
  }

  const held = new Set(granted.data.skills.map((skill) => skill.slug));
  if (catalogue.data.skills.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No skills are available yet. Create one from the Skills screen first.
      </p>
    );
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Skills add reusable instructions to this coworker. A skill never grants
        a connector by itself; every tool it uses is still checked against this
        Agent&apos;s tool grants and policy.
      </p>
      <div className="grid gap-2">
        {catalogue.data.skills.map((skill) => {
          const on = held.has(skill.slug);
          return (
            <Item key={skill.slug} variant="muted">
              <ItemContent>
                <ItemTitle>{skill.title}</ItemTitle>
                <ItemDescription>
                  {skill.summary || `/${skill.slug}`}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate({
                      kind: "skill",
                      ref: skill.slug,
                      agentId,
                      granted: !on,
                    })
                  }
                  size="sm"
                  variant={on ? "default" : "outline"}
                >
                  {on ? "Enabled" : "Enable"}
                </Button>
              </ItemActions>
            </Item>
          );
        })}
      </div>
      {change.error ? (
        <p className="text-xs text-destructive" role="alert">
          {change.error.message}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The server enforces ownership and administrator rules for every
          change; removing a skill takes effect on the next run.
        </p>
      )}
    </div>
  );
}
