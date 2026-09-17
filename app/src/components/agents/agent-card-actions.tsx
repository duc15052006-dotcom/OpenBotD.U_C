import { IconDotsVertical, IconMessageCircle, IconPencil } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * Fast actions for an owned agent card.
 *
 * This deliberately lives beside the card's navigation link rather than inside it. A menu trigger
 * nested in an anchor creates competing interactive controls and breaks keyboard semantics. Keeping
 * the two as siblings lets the whole card remain the large "open agent" target while this button
 * remains an independent, accessible target.
 */
export function AgentCardActions({ agent }: { agent: AgentProfile }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${agent.name}`}
        className={buttonVariants({
          className:
            "bg-background/80 shadow-sm backdrop-blur-sm hover:bg-background",
          size: "icon-sm",
          variant: "ghost",
        })}
      >
        <IconDotsVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem
          render={<Link search={{ agent: agent.id }} to="/agents" />}
        >
          <IconPencil />
          Edit agent
        </DropdownMenuItem>
        <DropdownMenuItem
          render={
            <Link search={{ agent: agent.id }} to="/channel/new" />
          }
        >
          <IconMessageCircle />
          Start channel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
