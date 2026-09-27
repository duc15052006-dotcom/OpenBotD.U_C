export type ComputerResourceProfile = "light" | "normal" | "heavy";

export const RESOURCE_PROFILES: Record<
  ComputerResourceProfile,
  { memoryBytes: number; nanoCpus: number }
> = {
  light: {
    memoryBytes: 1_610_612_736,
    nanoCpus: 1_000_000_000,
  },
  normal: {
    memoryBytes: 2_147_483_648,
    nanoCpus: 2_000_000_000,
  },
  heavy: {
    memoryBytes: 4_294_967_296,
    nanoCpus: 3_000_000_000,
  },
};

export function parseComputerResourceProfile(
  value: unknown,
): ComputerResourceProfile | null {
  return value === "light" || value === "normal" || value === "heavy"
    ? value
    : null;
}
