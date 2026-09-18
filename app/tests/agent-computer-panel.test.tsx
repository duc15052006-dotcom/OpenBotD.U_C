import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputerPanel } from "@/components/agents/computer-panel";
import { computerKeys } from "@/lib/computers/queries";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function draw(
  state: "ready" | "starting" | "absent" | "unreachable",
  canManage = true,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(computerKeys.status("writer"), {
    botId: "writer",
    state,
    canManage,
  });
  queryClient.setQueryData(computerKeys.metrics("writer"), {
    botId: "writer",
    state: "ready",
    metrics: {
      cpuPercent: 12.5,
      memoryUsedBytes: 256 * 1024 * 1024,
      memoryLimitBytes: 1024 * 1024 * 1024,
      workspaceUsedBytes: 2 * 1024 * 1024 * 1024,
      workspaceTotalBytes: 10 * 1024 * 1024 * 1024,
      measuredAt: "2026-09-18T00:00:00.000Z",
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ComputerPanel agentId="writer" />
    </QueryClientProvider>,
  );
}

test("shows lifecycle controls appropriate for a stopped computer", () => {
  const view = draw("absent");

  expect(view.getByText("Stopped")).toBeTruthy();
  expect(
    (view.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(
    (view.getByRole("button", { name: "Restart" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(view.getByText(/Reset.*deletes the saved browser profile/i)).toBeTruthy();
});

test("a viewer can see status without receiving destructive controls", () => {
  const view = draw("ready", false);

  expect(view.getByText("Running")).toBeTruthy();
  expect(view.queryByRole("button", { name: "Reset" })).toBeNull();
  expect(view.getByText(/only its owner or a deployment administrator/i)).toBeTruthy();
});

test("start uses the governed lifecycle endpoint and refreshes status", async () => {
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (
        path === "/api/computers/writer/computers/start" &&
        method === "POST"
      ) {
        return Response.json({ wasRunning: false });
      }
      if (path === "/api/computers/writer/status" && method === "GET") {
        return Response.json({
          botId: "writer",
          state: "ready",
          canManage: true,
        });
      }
      if (path === "/api/computers/writer/metrics" && method === "GET") {
        return Response.json({
          botId: "writer",
          state: "ready",
          metrics: {
            cpuPercent: 8,
            memoryUsedBytes: 128,
            memoryLimitBytes: 1024,
            workspaceUsedBytes: 64,
            workspaceTotalBytes: 2048,
            measuredAt: "2026-09-18T00:00:00.000Z",
          },
        });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    },
    { preconnect: originalFetch.preconnect },
  );

  const view = draw("absent");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("button", { name: "Start" }));

  await waitFor(() => expect(view.getByText("Running")).toBeTruthy());
  expect(requests).toContainEqual({
    path: "/api/computers/writer/computers/start",
    method: "POST",
  });
  expect(requests).toContainEqual({
    path: "/api/computers/writer/status",
    method: "GET",
  });
});
