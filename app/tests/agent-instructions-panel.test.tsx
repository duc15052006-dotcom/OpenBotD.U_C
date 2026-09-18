import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InstructionsPanel } from "@/components/agents/instructions-panel";
import { agentKeys } from "@/lib/agents/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function draw(canManage = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.instructions("writer"), {
    instructions: "Use primary sources.",
    canManage,
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <InstructionsPanel agentId="writer" />
    </QueryClientProvider>,
  );
}

test("shows the stored Agent-specific instructions", () => {
  const view = draw();

  expect(
    (view.getByLabelText("Agent instructions") as HTMLTextAreaElement).value,
  ).toBe("Use primary sources.");
  expect(
    view.getByText(/These instructions apply only to this coworker/),
  ).toBeTruthy();
});

test("saves only the edited instructions to this Agent", async () => {
  let saved: Record<string, unknown> | undefined;
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(path).toBe("/api/agents/writer/instructions");
      saved = JSON.parse(String(init?.body));
      return Response.json({
        instructions: {
          instructions: "Use primary sources and concise headings.",
          canManage: true,
        },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const textarea = view.getByLabelText("Agent instructions");

  await user.clear(textarea);
  await user.type(textarea, "Use primary sources and concise headings.");
  await user.click(view.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(saved).toBeDefined());
  expect(saved).toEqual({
    instructions: "Use primary sources and concise headings.",
  });
  expect(await view.findByText("Saved")).toBeTruthy();
});

test("read-only viewers cannot edit another Agent's instructions", () => {
  const view = draw(false);

  expect(
    (view.getByLabelText("Agent instructions") as HTMLTextAreaElement).disabled,
  ).toBe(true);
  expect(view.queryByRole("button", { name: "Save" })).toBeNull();
  expect(
    view.getByText("You can view these instructions but cannot change them."),
  ).toBeTruthy();
});
