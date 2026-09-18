import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  type Recipient,
  removeRecipient,
} from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { seedMessage } from "@/components/channels/transcript-messages";
import { SidebarToggle } from "@/components/layout/sidebar-toggle";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { defaultAgentProfile } from "@/lib/agents/default-agent";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates a direct or group channel on first send.
 *
 * `?agent=` still preselects a coworker from a profile/card link. Additional coworkers live in local
 * compose state until the first message creates the channel, so backing out never leaves an empty
 * group behind.
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const { startChosenMany, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const initialised = useRef(false);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const {
    data: fetched,
    isError: detailError,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });
  const initialChoice =
    listed ??
    (fetched?.id === agent ? fetched : undefined) ??
    (agent ? undefined : defaultAgentProfile(profiles));
  const needsUrlAgentDetail =
    Boolean(agent) && profiles !== undefined && !listed;
  const waitingForUrlAgent =
    needsUrlAgentDetail && detailPending && !detailError;
  const urlAgentDetailFailed = needsUrlAgentDetail && detailError && !fetched;
  const loadError =
    rosterError && profiles === undefined
      ? "Coworkers couldn't be loaded."
      : urlAgentDetailFailed
        ? "Coworker couldn't be loaded."
        : null;

  /*
   * Apply the URL/default choice once.
   *
   * A separate flag rather than `recipients.length === 0`: after somebody deliberately removes the
   * last chip we must not immediately put the default Bot back.
   */
  useEffect(() => {
    if (initialised.current || profiles === undefined || waitingForUrlAgent) {
      return;
    }
    initialised.current = true;
    if (initialChoice) {
      setRecipients([{ id: initialChoice.id, name: initialChoice.name }]);
    }
  }, [initialChoice, profiles, waitingForUrlAgent]);

  const selectedIds = new Set(recipients.map((recipient) => recipient.id));
  const available = (profiles ?? []).filter(
    (profile) => !selectedIds.has(profile.id),
  );
  // The first selected Bot owns the Intelligence thread. Peers are reached with @mentions.
  const coordinator = recipients[0];
  const skillCommands = useSkillCommands(coordinator?.id ?? "");

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-12 border-b border-border sticky top-0 z-10 flex flex-wrap items-center gap-1.5 bg-background px-2 py-1.5">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>

        {recipients.map((recipient, index) => (
          <button
            aria-label={`Remove ${recipient.name}`}
            className="flex max-w-48 items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-1 text-xs hover:bg-muted"
            key={recipient.id}
            onClick={() =>
              setRecipients((current) =>
                removeRecipient(current, recipient.id),
              )
            }
            title={
              index === 0 && recipients.length > 1
                ? `${recipient.name} coordinates this group`
                : `Remove ${recipient.name}`
            }
            type="button"
          >
            <ChannelAvatar participantIds={[recipient.id]} size={18} />
            <span className="truncate">{recipient.name}</span>
            {index === 0 && recipients.length > 1 ? (
              <span className="text-muted-foreground">· coordinator</span>
            ) : null}
            <span aria-hidden className="text-muted-foreground">
              ×
            </span>
          </button>
        ))}

        {recipients.length < MAX_RECIPIENTS ? (
          <div className="min-w-44 flex-1">
            <Combobox
              autoHighlight
              defaultOpen={
                !initialChoice && !loadError && !waitingForUrlAgent
              }
              items={available}
              isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
                item.id === value.id
              }
              itemToStringLabel={(item: AgentProfile) => item.name}
              itemToStringValue={(item: AgentProfile) => item.id}
              onValueChange={(next) => {
                if (!next) return;
                setRecipients((current) =>
                  addRecipient(current, { id: next.id, name: next.name }),
                );
              }}
              value={null}
            >
              <ComboboxInput
                autoFocus={recipients.length === 0}
                placeholder={
                  recipients.length === 0
                    ? "Choose a coworker…"
                    : "Add coworker…"
                }
                className="border-none w-full bg-transparent! text-sm has-[[data-slot=input-group-control]:focus-visible]:ring-0"
              />
              <ComboboxContent className="min-w-0 max-w-lg" sideOffset={12}>
                <ComboboxEmpty>No more agents available.</ComboboxEmpty>
                <ComboboxList>
                  {(item: AgentProfile) => (
                    <ComboboxItem key={item.id} value={item} className="h-10">
                      <ChannelAvatar participantIds={[item.id]} size={24} />
                      {item.name}
                      <span className="truncate text-muted-foreground ml-1">
                        {item.title}
                      </span>
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            Group limit: {MAX_RECIPIENTS}
          </span>
        )}
      </div>

      <ConversationView
        // Once at least one Bot is chosen, the remaining task is the message.
        autoFocus
        // The first Bot is the coordinator, so its skills apply to the first message.
        commands={skillCommands}
        disabled={
          Boolean(loadError) || waitingForUrlAgent || recipients.length === 0
        }
        messages={sent ? [sent] : []}
        notice={
          loadError || error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {loadError ?? error}
            </p>
          ) : recipients.length > 1 ? (
            <p className="pb-2 text-sm text-muted-foreground" role="status">
              {coordinator?.name} coordinates this group. After it opens, use{" "}
              @mentions to send a message to a specific coworker.
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          if (!canSend(recipients, draft.text)) return;

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            await startChosenMany(
              recipients.map((recipient) => recipient.id),
              draft.text,
            );
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
