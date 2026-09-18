/**
 * System instruction used when a group-channel message explicitly @mentions a peer Bot.
 *
 * One Intelligence thread still has one runtime Bot, the coordinator. The peer is run through the
 * durable handoff queue and its answer is relayed back into the same conversation. Keeping this
 * instruction separate from the person's words preserves the transcript and keeps routing testable.
 */
export function groupMentionInstruction(input: {
  coordinatorId: string;
  targetId: string;
  targetName: string;
}): string {
  return [
    "GROUP CHANNEL ROUTING:",
    `The person explicitly addressed ${input.targetName} (Bot id: ${input.targetId}), not you (${input.coordinatorId}).`,
    `Use the message_bot tool exactly once with target "${input.targetId}".`,
    "Put the person's request into the handoff task faithfully. Preserve constraints and requested output format.",
    "Do not solve the task yourself and do not choose a different Bot.",
    `After the handoff is accepted, only tell the person that ${input.targetName} is working on it. The final answer will be relayed back into this conversation.`,
  ].join("\n");
}
