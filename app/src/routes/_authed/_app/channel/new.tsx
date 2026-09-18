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
import { toAgentOptions } from "@/components/channels/composer";
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
import { routeMessage } from "@/lib/channels/route";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";
import { newId } from "../../../../lib/new-id";

/**
 * Creates a direct or group channel on first send.
 *
 * A profile link can still seed one recipient through ?agent=. Additional coworkers are selected
 * in-place and become one channel roster; no empty channel is written before the first message.
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent } = Route.useSearch();
  const { startGroup, pending } = useStartChannel();
  const { data: profiles, isError: rosterError } = useQuery(
    agentListQueryOptions(),
  );

  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Message | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    agent ? [agent] : [],
  );
  const seededDefault = useRef(Boolean(agent));

  const listed = profiles?.find((profile) => profile.id === agent);
  const {
    data: fetched,
    isError: detailError,
    isPending: detailPending,
  } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && profiles !== undefined && !listed,
    retry: false,
  });

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

  // Keep profile links working exactly as before: the URL names the first recipient.
  useEffect(() => {
    if (!agent) return;
    setSelectedIds((current) =>
      current.includes(agent) ? current : [agent, ...current].slice(0, MAX_RECIPIENTS),
    );
    seededDefault.current = true;
  }, [agent]);

  // The plain /channel/new route keeps the old convenience of starting with the default coworker,
  // but only once. If the person removes it, an effect must not silently put it back.
  useEffect(() => {
    if (seededDefault.current || agent || !profiles) return;
    seededDefault.current = true;
    const fallback = defaultAgentProfile(profiles);
    if (fallback) setSelectedIds([fallback.id]);
  }, [agent, profiles]);

  const profileFor = (id: string): AgentProfile | undefined =>
    profiles?.find((profile) => profile.id === id) ??
    (fetched?.id === id ? fetched : undefined);

  const recipients: Recipient[] = selectedIds
    .map((id) => profileFor(id))
    .filter((profile): profile is AgentProfile => Boolean(profile))
    .map((profile) => ({ id: profile.id, name: profile.name }));

  const available = (profiles ?? []).filter(
    (profile) => !selectedIds.includes(profile.id),
  );
  const primary = recipients[0];
  const skillCommands = useSkillCommands(
    recipients.length === 1 ? (primary?.id ?? "") : "",
  );

  const add = (profile: AgentProfile | null) => {
    if (!profile) return;
    const next = addRecipient(recipients, {
      id: profile.id,
      name: profile.name,
    });
    setSelectedIds(next.map((recipient) => recipient.id));
  };

  const remove = (id: string) => {
    setSelectedIds(removeRecipient(recipients, id).map((recipient) => recipient.id));
  };

  if (profiles === undefined && !rosterError) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-12 border-b border-border sticky top-0 flex flex-wrap items-center gap-2 px-2 py-1.5">
        <SidebarToggle className="mr-1" />
        <span className="text-sm text-muted-foreground">To:</span>

        {recipients.map((recipient) => (
          <button
            aria-label={`Remove ${recipient.name}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-1 text-sm hover:bg-muted"
            key={recipient.id}
            onClick={() => remove(recipient.id)}
            type="button"
          >
            <ChannelAvatar participantIds={[recipient.id]} size={20} />
            <span className="max-w-36 truncate">{recipient.name}</span>
            <span aria-hidden="true" className="text-muted-foreground">
              ×
            </span>
          </button>
        ))}

        {recipients.length < MAX_RECIPIENTS ? (
          <Combobox
            autoHighlight
            defaultOpen={recipients.length === 0 && !loadError && !waitingForUrlAgent}
            items={available}
            isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
              item.id === value.id
            }
            itemToStringLabel={(item: AgentProfile) => item.name}
            itemToStringValue={(item: AgentProfile) => item.id}
            onValueChange={add}
            value={null}
          >
            <ComboboxInput
              autoFocus={recipients.length === 0}
              className="min-w-40 border-none bg-transparent! text-sm has-[[data-slot=input-group-control]:focus-visible]:ring-0"
              placeholder={
                recipients.length === 0
                  ? "Choose coworkers…"
                  : "Add coworker…"
              }
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
        ) : (
          <span className="text-muted-foreground text-xs">
            Group limit reached ({MAX_RECIPIENTS})
          </span>
        )}
      </div>

      <ConversationView
        agents={toAgentOptions(profiles, selectedIds)}
        autoFocus
        commands={recipients.length === 1 ? skillCommands : []}
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
              Group chat: use @ to choose which coworker should answer a message.
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          if (!canSend(recipients, draft.text)) return;
          const targetId =
            draft.agentId && selectedIds.includes(draft.agentId)
              ? draft.agentId
              : selectedIds[0];
          if (!targetId) return;

          setError(null);
          setSent(seedMessage(draft.text, newId()));

          try {
            // The chosen responder is recorded before the channel is created. In a group the
            // roster itself is the durable membership; this row records who the first message
            // actually addressed.
            await routeMessage(draft.text, targetId).catch(() => undefined);
            await startGroup(selectedIds, draft.text, targetId);
          } catch (caught) {
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
