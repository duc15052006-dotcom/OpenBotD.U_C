import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillsPanel } from "@/components/agents/skills-panel";
import { pluginKeys } from "@/lib/plugins/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const skill = {
  id: "skill-1",
  slug: "research",
  ownerUserId: "user-1",
  title: "Research",
  summary: "Verify claims with sources.",
  instructions: "Use primary sources.",
  origin: "user",
  installedBy: "user@example.test",
  grantedTo: [],
  tools: [],
};

function draw(enabled = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(pluginKeys.page(), {
    catalogue: [],
    servers: [],
    skills: [skill],
    botsMayCallBack: true,
    redirectUri: null,
    composioConfigured: false,
  });
  queryClient.setQueryData(pluginKeys.forAgent("writer"), {
    tools: [],
    skills: enabled
      ? [
          {
            slug: skill.slug,
            title: skill.title,
            summary: skill.summary,
            instructions: skill.instructions,
          },
        ]
      : [],
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsPanel agentId="writer" />
    </QueryClientProvider>,
  );
}

test("shows whether a skill is enabled for this Agent", () => {
  const off = draw(false);
  expect(off.getByText("Research")).toBeTruthy();
  expect(off.getByRole("button", { name: "Enable" })).toBeTruthy();
  cleanup();

  const on = draw(true);
  expect(on.getByRole("button", { name: "Enabled" })).toBeTruthy();
});

test("uses the existing skill grant endpoint when enabling a skill", async () => {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(path);
      if (url === "/api/plugins/grants") {
        body = JSON.parse(String(init?.body));
        return Response.json({ ok: true });
      }
      if (url === "/api/plugins") {
        return Response.json({
          catalogue: [],
          servers: [],
          skills: [{ ...skill, grantedTo: ["writer"] }],
          botsMayCallBack: true,
          redirectUri: null,
          composioConfigured: false,
        });
      }
      if (url === "/api/plugins/for/writer") {
        return Response.json({
          tools: [],
          skills: [
            {
              slug: skill.slug,
              title: skill.title,
              summary: skill.summary,
              instructions: skill.instructions,
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );

  const view = draw(false);
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Enable" }));

  await waitFor(() => expect(body).toBeDefined());
  expect(body).toEqual({
    kind: "skill",
    ref: "research",
    agentId: "writer",
  });
});
