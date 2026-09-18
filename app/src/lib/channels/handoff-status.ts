import { HANDED_OVER } from "../../../../shared/handoff-markers";

export type HandoffDisplay =
  | { state: "running" }
  | { state: "accepted"; target: string }
  | { state: "refused"; reason: string };

/**
 * Interpret the stable message_bot result contract for the transcript.
 *
 * Accepted results share HANDED_OVER with the server. Every other completed result is a refusal
 * sentence returned by the handoff desk.
 */
export function readHandoffDisplay(result?: string): HandoffDisplay {
  if (result === undefined) return { state: "running" };

  const text = result.trim();
  if (!text.startsWith(HANDED_OVER)) {
    return { state: "refused", reason: text };
  }

  const remainder = text.slice(HANDED_OVER.length).trim();
  const target = remainder.split(".")[0]?.trim() || "coworker";
  return { state: "accepted", target };
}
