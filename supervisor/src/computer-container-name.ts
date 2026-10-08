/** Whether Docker's listed names identify the one primary Computer container for a Bot. */
export function isPrimaryComputerContainerName(
  expected: string,
  listed: string[] | undefined,
): boolean {
  return (listed ?? []).some((name) => name.replace(/^\/+/, "") === expected);
}
