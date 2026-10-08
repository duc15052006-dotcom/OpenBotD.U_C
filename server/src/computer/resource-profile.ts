export type ComputerResourceProfile = "light" | "normal" | "heavy";

export const DEFAULT_COMPUTER_RESOURCE_PROFILE: ComputerResourceProfile =
  "normal";

/**
 * Server-side parser for the only resource profile names the supervisor accepts.
 *
 * Quotas themselves are deliberately not supplied by the browser/API caller; the supervisor owns
 * the numeric mapping so a modified request cannot turn "Heavy" into unlimited host resources.
 */
export function computerResourceProfile(
  value: unknown,
): ComputerResourceProfile | null {
  return value === "light" || value === "normal" || value === "heavy"
    ? value
    : null;
}
