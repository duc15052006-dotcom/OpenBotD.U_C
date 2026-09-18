/**
 * The rules a compose screen follows before there is a channel to hold them.
 *
 * Pure helpers so recipient-cap and sendability behavior stay testable without rendering.
 */

export type Recipient = {
  id: string;
  name: string;
};

/**
 * A small group is enough to coordinate several specialist Bots without turning the mention menu
 * into a deployment-wide roster. The server still validates every id against the caller's roster.
 */
export const MAX_RECIPIENTS = 8;

/** Add a coworker unless this group is already at its explicit participant cap. */
export function addRecipient(
  current: readonly Recipient[],
  next: Recipient,
): Recipient[] {
  if (current.some((recipient) => recipient.id === next.id)) {
    return [...current];
  }
  if (current.length >= MAX_RECIPIENTS) return [...current];
  return [...current, next];
}

export function removeRecipient(
  current: readonly Recipient[],
  id: string,
): Recipient[] {
  return current.filter((recipient) => recipient.id !== id);
}

/** Whether this draft can start a channel. */
export function canSend(
  recipients: readonly Recipient[],
  text: string,
): boolean {
  return (
    recipients.length > 0 &&
    recipients.length <= MAX_RECIPIENTS &&
    text.trim().length > 0
  );
}
