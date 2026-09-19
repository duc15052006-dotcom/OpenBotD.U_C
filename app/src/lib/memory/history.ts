export type MemoryKind = "topical" | "episodic" | "operational";
export type MemoryScope = "user" | "project";

export type MemoryHistoryRecord = {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  content: string;
  sourceThreadIds: readonly string[];
  invalidatedAt: string | null;
};

export async function loadMemoryHistory(): Promise<MemoryHistoryRecord[]> {
  const response = await fetch(
    "/api/copilotkit/memories?includeInvalidated=true",
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "Memory history is not available for this account."
        : "Could not load memory history.",
    );
  }
  const body = (await response.json().catch(() => null)) as {
    memories?: unknown;
  } | null;
  if (!Array.isArray(body?.memories)) {
    throw new Error("Memory history returned an invalid response.");
  }
  return body.memories.filter((value): value is MemoryHistoryRecord => {
    if (!value || typeof value !== "object") return false;
    const one = value as Partial<MemoryHistoryRecord>;
    return (
      typeof one.id === "string" &&
      typeof one.content === "string" &&
      (one.kind === "topical" ||
        one.kind === "episodic" ||
        one.kind === "operational") &&
      (one.scope === "user" || one.scope === "project") &&
      Array.isArray(one.sourceThreadIds) &&
      (one.invalidatedAt === null || typeof one.invalidatedAt === "string")
    );
  });
}
