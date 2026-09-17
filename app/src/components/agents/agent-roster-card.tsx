import { Link, useNavigate } from "@tanstack/react-router";
import { AgentActionsMenu } from "@/components/agents/agent-actions-menu";
import { AgentCard } from "@/components/agents/agent-card";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * One agent in the roster, including the navigation affordances around the visual card.
 *
 * Keeping the menu next to the link (rather than inside it) avoids nested interactive controls:
 * the card opens the profile, while the three-dot button remains an independent keyboard target.
 */
export function AgentRosterCard({ agent }: { agent: AgentProfile }) {
  const navigate = useNavigate();

  return (
    <div className="relative h-[180px] w-[144px]">
      <Link
        aria-label={`Open ${agent.name}`}
        className="block rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        search={{ agent: agent.id }}
        to="/agents"
      >
        <AgentCard agent={agent} />
      </Link>
      <AgentActionsMenu
        agentName={agent.name}
        onOpenSettings={() =>
          void navigate({ search: { agent: agent.id }, to: "/agents" })
        }
        onStartChannel={() =>
          void navigate({
            search: { agent: agent.id },
            to: "/channel/new",
          })
        }
      />
    </div>
  );
}
