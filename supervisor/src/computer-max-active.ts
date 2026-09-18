/**
 * Maximum number of per-Bot Computer containers that may be running at once.
 *
 * Zero is not accepted: disabling the Computer provider is a different deployment decision. The
 * desktop default is three, sized for the 16 GiB Windows-first target; operators with more memory can
 * raise it explicitly.
 */
export function computerMaxActive(
  raw: string | undefined,
): { ok: true; maxActive: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, maxActive: undefined };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      reason: `COMPUTER_MAX_ACTIVE must be a positive whole number (got ${JSON.stringify(raw)}).`,
    };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > 128) {
    return {
      ok: false,
      reason: `COMPUTER_MAX_ACTIVE must be between 1 and 128 (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, maxActive: value };
}
