import { IconDots, IconMessageCircle, IconSettings } from "@tabler/icons-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Fast actions for one agent in the roster.
 *
 * This stays deliberately presentation-only: the roster owns navigation and later can wire
 * lifecycle mutations without teaching a reusable menu about routes or server state.
 */
export function AgentActionsMenu({
  agentName,
  onOpenSettings,
  onStartChannel,
}: {
  agentName: string;
  onOpenSettings: () => void;
  onStartChannel: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${agentName}`}
        className="absolute right-2 top-2 z-10 inline-flex size-8 items-center justify-center rounded-full bg-background/85 text-foreground shadow-sm ring-1 ring-foreground/10 backdrop-blur-sm transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <IconDots className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={onOpenSettings}>
          <IconSettings />
          Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onStartChannel}>
          <IconMessageCircle />
          Start channel
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
