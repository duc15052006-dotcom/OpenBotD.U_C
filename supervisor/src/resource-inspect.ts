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

/**
 * A stopped Computer's connection mode is fixed when the container is created.
 * Running with a new COMPUTER_NETWORK cannot be repaired by container.update():
 * it would return a new DNS URL for a container still on the old network.
 * Docker calls its unconfigured bridge "default" or "bridge"; both are equivalent.
 */
export function networkModeNeedsRecreation(
  inspected: string | undefined,
  requested: string | undefined,
): boolean {
  if (requested) return inspected !== requested;
  return inspected !== undefined && inspected !== "default" && inspected !== "bridge";
}
