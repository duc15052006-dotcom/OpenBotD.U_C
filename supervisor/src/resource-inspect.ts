/**
 * The effective CPU limit represented by Docker-compatible inspect output.
 *
 * Docker reports NanoCpus directly. Podman's compatibility API can instead report the equivalent
 * CpuPeriod/CpuQuota pair and leave NanoCpus at zero, especially for limits above one CPU. Treat
 * those two representations as the same resource limit so a stopped Computer can wake without
 * trying to "repair" a quota the engine already enforces.
 */
export function inspectedNanoCpus(
  hostConfig:
    | {
        NanoCpus?: number;
        CpuPeriod?: number;
        CpuQuota?: number;
      }
    | undefined,
): number | undefined {
  const direct = hostConfig?.NanoCpus;
  if (typeof direct === "number" && direct > 0) return direct;

  const period = hostConfig?.CpuPeriod;
  const quota = hostConfig?.CpuQuota;
  if (
    typeof period === "number" &&
    period > 0 &&
    typeof quota === "number" &&
    quota > 0
  ) {
    return Math.round((quota / period) * 1_000_000_000);
  }

  return typeof direct === "number" ? direct : undefined;
}

/**
 * Docker spells an explicit no-restart policy as "no"; compatible engines may omit the name.
 * Both mean OpenBot, rather than the engine, owns when an Agent Computer is started.
 */
export function inspectedRestartPolicyName(name: string | undefined): string {
  return name?.trim() || "no";
}

export type InspectedComputerResources = {
  memoryBytes?: number;
  nanoCpus?: number;
  restartPolicyName?: string;
};

export type RequestedComputerResources = {
  memoryBytes?: number;
  nanoCpus?: number;
};

/** Whether an existing Computer already reflects the resource/lifecycle policy OpenBot requested. */
export function computerResourcesMatch(
  existing: InspectedComputerResources | null,
  requested: RequestedComputerResources,
): boolean {
  if (!existing) return false;
  return (
    (requested.memoryBytes === undefined ||
      existing.memoryBytes === requested.memoryBytes) &&
    (requested.nanoCpus === undefined ||
      existing.nanoCpus === requested.nanoCpus) &&
    (existing.restartPolicyName ?? "no") === "no"
  );
}

/**
 * Prefer an in-place resource update, but recover by rebuilding only the container when a
 * Docker-compatible engine cannot represent/apply that update exactly.
 *
 * The fallback deliberately knows nothing about volumes. Its caller owns the lifecycle operation
 * and supplies a replacement callback that removes only the container with v=false. Keeping that
 * separation makes it impossible for a profile change to accidentally acquire Reset semantics.
 */
export async function reconcileComputerResources<
  T extends InspectedComputerResources,
>(
  existing: T,
  requested: RequestedComputerResources,
  updateAndInspect: () => Promise<T | null>,
  replaceContainerKeepingVolumes: () => Promise<void>,
): Promise<T | null> {
  if (computerResourcesMatch(existing, requested)) return existing;

  try {
    const updated = await updateAndInspect();
    if (computerResourcesMatch(updated, requested)) return updated;
  } catch {
    // Podman's Docker-compatible update endpoint may refuse a legal CPU/RAM transition. The safe
    // recovery is below: replace the container, never its named persistent volumes.
  }

  await replaceContainerKeepingVolumes();
  return null;
}
