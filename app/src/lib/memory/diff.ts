export type MemoryDiffLine = {
  type: "same" | "added" | "removed";
  text: string;
};

/**
 * Linear diff for bounded memory text. It preserves the common prefix/suffix and marks only the
 * changed middle, avoiding quadratic LCS work over user-controlled content.
 */
export function diffMemoryLines(from: string, to: string): MemoryDiffLine[] {
  const left = from.split("\n");
  const right = to.split("\n");
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const out: MemoryDiffLine[] = [];
  for (let i = 0; i < prefix; i += 1) {
    out.push({ type: "same", text: left[i] ?? "" });
  }
  for (let i = prefix; i < left.length - suffix; i += 1) {
    out.push({ type: "removed", text: left[i] ?? "" });
  }
  for (let i = prefix; i < right.length - suffix; i += 1) {
    out.push({ type: "added", text: right[i] ?? "" });
  }
  for (let i = left.length - suffix; i < left.length; i += 1) {
    out.push({ type: "same", text: left[i] ?? "" });
  }
  return out;
}
