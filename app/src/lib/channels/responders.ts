/**
 * Pick the Bot that should answer one message in a channel.
 *
 * An explicit @mention wins when it names a channel member. Otherwise a live group conversation
 * stays with its current responder; a brand-new group falls back to the first member.
 */
export function resolveChannelResponder(
  agentIds: readonly string[],
  requestedAgentId: string | null | undefined,
  currentAgentId?: string | null,
): string | null {
  if (requestedAgentId && agentIds.includes(requestedAgentId)) {
    return requestedAgentId;
  }
  if (currentAgentId && agentIds.includes(currentAgentId)) {
    return currentAgentId;
  }
  return agentIds[0] ?? null;
}
