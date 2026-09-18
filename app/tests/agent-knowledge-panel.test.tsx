import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KnowledgePanel } from "@/components/agents/knowledge-panel";
import { agentKeys } from "@/lib/agents/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const base = {
  documents: [
    {
      id: "doc-1",
      name: "policy.txt",
      mimeType: "text/plain",
      sizeBytes: 24,
      characters: 24,
      createdAt: "2026-09-18T00:00:00.000Z",
    },
  ],
  canManage: true,
  limits: {
    documents: 8,
    fileBytes: 65_536,
    documentCharacters: 60_000,
    totalCharacters: 120_000,
  },
};

function draw(canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.knowledge("writer"), {
    ...base,
    canManage,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KnowledgePanel agentId="writer" />
    </QueryClientProvider>,
  );
}

test("shows uploaded knowledge metadata without file contents", () => {
  const view = draw();

  expect(view.getByText("policy.txt")).toBeTruthy();
  expect(view.getByText(/24 B/)).toBeTruthy();
  expect(view.container.textContent).not.toContain("secret file contents");
});

test("removes a knowledge file through the Agent endpoint", async () => {
  let requested = "";
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      requested = String(path);
      return Response.json({ knowledge: { ...base, documents: [] } });
    },
    { preconnect: originalFetch.preconnect },
  );

  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Remove" }));

  await waitFor(() =>
    expect(requested).toBe("/api/agents/writer/knowledge/doc-1"),
  );
  await waitFor(() => expect(view.queryByText("policy.txt")).toBeNull());
});

test("read-only viewers can inspect metadata but cannot mutate it", () => {
  const view = draw(false);

  expect(
    (view.getByLabelText("Upload knowledge file") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(
    (view.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    view.getByText(/you cannot change them/i),
  ).toBeTruthy();
});

test("uploads the original bytes as bounded base64 JSON", async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = Object.assign(
    async (_path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ knowledge: base });
    },
    { preconnect: originalFetch.preconnect },
  );

  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const input = view.getByLabelText("Upload knowledge file");
  const file = new File(["Known fact."], "facts.txt", { type: "text/plain" });

  await user.upload(input, file);

  await waitFor(() => expect(body).toBeDefined());
  expect(body).toEqual({
    name: "facts.txt",
    mimeType: "text/plain",
    bytesBase64: Buffer.from("Known fact.").toString("base64"),
  });
});
