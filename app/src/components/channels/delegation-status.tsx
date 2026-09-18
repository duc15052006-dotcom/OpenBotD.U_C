import {
  IconCircleCheck,
  IconCircleX,
  IconClock,
  IconLoader2,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useBotNames } from "@/lib/agents/bot-names";
import {
  type ChannelDelegation,
  channelDelegationsQueryOptions,
} from "@/lib/channels/queries";
import { cn } from "@/lib/utils";

/**
 * Small live view of Bot-to-Bot work connected to this conversation.
 *
 * A delegation is durable work, so the UI reads the queue state rather than guessing from chat
 * messages. Finished rows remain visible briefly in the queue's retention window, which makes a
 * handoff understandable after it completes instead of flashing in and disappearing.
 */
export function DelegationStatus({ channelId }: { channelId: string }) {
  const delegations = useQuery(channelDelegationsQueryOptions(channelId));
  const nameFor = useBotNames();

  if (delegations.isPending || delegations.isError) return null;

  const rows = delegations.data ?? [];
  if (rows.length === 0) return null;

  // Active work first, then the newest completed work. Three rows keep this a status strip rather
  // than turning the conversation screen into a second audit page.
  const visible = [...rows]
    .sort((left, right) => {
      const leftActive = left.state === "queued" || left.state === "working";
      const rightActive = right.state === "queued" || right.state === "working";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, 3);

  return (
    <section
      aria-label="Delegation status"
      className="border-border border-b bg-muted/20 px-3 py-2"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        {visible.map((delegation) => (
          <DelegationRow
            delegation={delegation}
            key={delegation.key}
            nameFor={nameFor}
          />
        ))}
      </div>
    </section>
  );
}

function DelegationRow({
  delegation,
  nameFor,
}: {
  delegation: ChannelDelegation;
  nameFor: (botId: string) => string;
}) {
  const state = STATE[delegation.state];
  const Icon = state.icon;

  return (
    <div className="flex min-w-0 items-center gap-2 text-xs">
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          delegation.state === "working" && "animate-spin",
          state.className,
        )}
      />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        <span
          className="font-medium text-foreground"
          title={delegation.fromBotId}
        >
          {nameFor(delegation.fromBotId)}
        </span>
        {" → "}
        <span
          className="font-medium text-foreground"
          title={delegation.toBotId}
        >
          {nameFor(delegation.toBotId)}
        </span>
        {" · "}
        <span title={delegation.task}>{delegation.task}</span>
      </span>
      <span className={cn("shrink-0 font-medium", state.className)}>
        {state.label}
        {delegation.state === "failed" && delegation.attempts > 1
          ? ` after ${delegation.attempts} tries`
          : ""}
      </span>
    </div>
  );
}

const STATE = {
  queued: {
    label: "Queued",
    icon: IconClock,
    className: "text-muted-foreground",
  },
  working: {
    label: "Working",
    icon: IconLoader2,
    className: "text-amber-600 dark:text-amber-500",
  },
  delivered: {
    label: "Delivered",
    icon: IconCircleCheck,
    className: "text-emerald-600 dark:text-emerald-500",
  },
  failed: {
    label: "Failed",
    icon: IconCircleX,
    className: "text-destructive",
  },
} as const;
