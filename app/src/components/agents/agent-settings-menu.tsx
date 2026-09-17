import {
  IconDotsVertical,
  IconMessageCircle,
  IconSettings,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * The compact way into one coworker's controls.
 *
 * The trigger deliberately lives outside the card's navigation link (see the roster): putting a
 * button inside that link would create nested interactive controls, so keyboard and pointer
 * activation could open both the menu and the profile at once. The menu owns only real actions;
 * deeper Model, Computer and Knowledge entries will appear here when those settings have a real
 * backing API rather than as dead placeholders.
 */
export function AgentSettingsMenu({
  agent,
  onOpenSettings,
}: {
  agent: AgentProfile;
  onOpenSettings: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Open settings for ${agent.name}`}
            className="bg-background/80 shadow-sm backdrop-blur-sm hover:bg-background"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <IconDotsVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" sideOffset={6}>
        <DropdownMenuItem onClick={onOpenSettings}>
          <IconSettings />
          Agent settings
        </DropdownMenuItem>
        <DropdownMenuItem
          render={<Link search={{ agent: agent.id }} to="/channel/new" />}
        >
          <IconMessageCircle />
          Start channel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
