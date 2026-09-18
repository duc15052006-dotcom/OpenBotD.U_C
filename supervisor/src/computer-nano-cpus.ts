/**
 * Optional Docker CPU cap for each computer, expressed in NanoCPUs.
 *
 * Docker uses 1_000_000_000 NanoCPUs for one logical CPU. The parser is strict because a resource
 * boundary that silently accepts a malformed value is not a boundary an operator can trust.
 */
export function computerNanoCpus(
  raw: string | undefined,
): { ok: true; nanoCpus: number | undefined } | { ok: false; reason: string } {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, nanoCpus: undefined };
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      reason: `COMPUTER_NANO_CPUS must be a whole number of NanoCPUs (got ${JSON.stringify(raw)}).`,
    };
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    return {
      ok: false,
      reason: `COMPUTER_NANO_CPUS must be a positive safe integer (got ${JSON.stringify(raw)}).`,
    };
  }
  return { ok: true, nanoCpus: value };
}
