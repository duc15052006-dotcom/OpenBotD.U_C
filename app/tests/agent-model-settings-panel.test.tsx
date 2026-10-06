import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelSettingsPanel } from "@/components/agents/model-settings-panel";
import { agentKeys } from "@/lib/agents/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function draw() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(agentKeys.model("writer"), {
    mode: "custom",
    provider: "openai",
    model: "gpt-custom",
    credentialSource: "custom",
    hasApiKey: true,
    baseUrl: "https://models.example.test/v1",
    temperature: 0.4,
    maxTokens: 2048,
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModelSettingsPanel agentId="writer" builtIn />
    </QueryClientProvider>,
  );
}

test("shows configured secret state without ever reading the secret back", () => {
  const view = draw();

  expect((view.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  expect(
    view.getByText("API key configured. It cannot be read back."),
  ).toBeTruthy();
  expect(view.container.textContent).not.toContain("secret-value");
});

test("leaving a configured key blank preserves it in the save request", async () => {
  let saved: Record<string, unknown> | undefined;
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(path).toBe("/api/agents/writer/model");
      saved = JSON.parse(String(init?.body));
      return Response.json({
        model: {
          mode: "custom",
          provider: "openai",
          model: "gpt-custom",
          credentialSource: "custom",
          hasApiKey: true,
        },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(view.getByRole("button", { name: "Save settings" }));

  await waitFor(() => expect(saved).toBeDefined());
  expect(saved).toMatchObject({
    mode: "custom",
    provider: "openai",
    model: "gpt-custom",
    credentialSource: "custom",
  });
  expect(saved).not.toHaveProperty("apiKey");
});


test("saving a replacement key clears only the field and confirms secure storage", async () => {
  let saved: Record<string, unknown> | undefined;
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(path).toBe("/api/agents/writer/model");
      saved = JSON.parse(String(init?.body));
      return Response.json({
        model: {
          mode: "custom",
          provider: "openai",
          model: "gpt-custom",
          credentialSource: "custom",
          hasApiKey: true,
          baseUrl: "https://models.example.test/v1",
        },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const key = view.getByLabelText("API key") as HTMLInputElement;

  await user.type(key, "replacement-secret");
  await user.click(view.getByRole("button", { name: "Save settings" }));

  await waitFor(() =>
    expect(
      view.getByText(
        "Settings saved. The custom API key is stored securely; the field is cleared intentionally.",
      ),
    ).toBeTruthy(),
  );
  expect(saved).toMatchObject({
    mode: "custom",
    credentialSource: "custom",
    apiKey: "replacement-secret",
  });
  expect(key.value).toBe("");
  expect(view.container.textContent).not.toContain("replacement-secret");
});

test("editing settings clears a stale connection-test failure", async () => {
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      expect(path).toBe("/api/agents/writer/model/test");
      return Response.json({
        connection: {
          ok: false,
          error: "Old provider failure",
        },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const view = draw();
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(view.getByRole("button", { name: "Test connection" }));
  await waitFor(() => expect(view.getByText("Old provider failure")).toBeTruthy());

  await user.type(view.getByLabelText("Model"), "-next");

  await waitFor(() =>
    expect(view.queryByText("Old provider failure")).toBeNull(),
  );
});
