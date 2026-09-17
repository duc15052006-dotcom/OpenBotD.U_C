import { IconDotsVertical, IconMessageCircle, IconSettings } from "@tabler/icons-react";
import { Link, useNavigate } from "@tanstack/react-router";
import Avatar from "boring-avatars";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * Compact roster card for one coworker.
 *
 * The full-card link and the quick-action menu are siblings rather than nested interactive
 * controls. That keeps the entire card easy to open while preserving valid, keyboard-accessible
 * markup for the three-dot menu.
 */
export function AgentCard({ agent }: { agent: AgentProfile }) {
  const navigate = useNavigate();

  return (
    <div className="h-[180px] bg-foreground/10 rounded-2xl w-[144px] relative overflow-hidden group">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <Avatar name={agent.avatarSeed} size={250} />
      </div>
      <div className="absolute top-0 left-0 w-full h-full bg-background/40 dark:bg-background/50" />
      <div className="pointer-events-none absolute top-0 left-0 w-full h-full flex flex-col justify-end p-3 gap-2">
        <span className="text-sm font-medium line-clamp-1">{agent.name}</span>
        <span className="text-xs text-foreground dark:text-foreground/80 line-clamp-3">
          {agent.roleDescription}
        </span>
      </div>

      <Link
        aria-label={`Open ${agent.name}`}
        className="absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        search={{ agent: agent.id }}
        to="/agents"
      />

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`More actions for ${agent.name}`}
          className="absolute right-2 top-2 z-20 inline-flex size-8 items-center justify-center rounded-full bg-background/80 text-foreground shadow-sm opacity-0 backdrop-blur-sm transition-opacity hover:bg-background focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 data-popup-open:opacity-100"
        >
          <IconDotsVertical className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            onClick={() =>
              void navigate({
                search: { agent: agent.id },
                to: "/agents",
              })
            }
          >
            <IconSettings />
            Agent settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              void navigate({
                search: { agent: agent.id },
                to: "/channel/new",
              })
            }
          >
            <IconMessageCircle />
            Start channel
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
