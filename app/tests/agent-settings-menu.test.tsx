import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentSettingsMenu } from "@/components/agents/agent-settings-menu";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * The three-dot menu is intentionally tested apart from the roster. The roster's card remains a
 * navigation link while this menu is a sibling interactive control; exercising the menu here pins
 * what it owns without coupling the test to the agents page's query/loading states.
 *
 * Match the repository's DOM-test harness: bun runs files in one process, so Happy DOM is registered
 * for this file's lifetime and queries come from render() rather than the global screen object.
 */
beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

const AGENT: AgentProfile = {
  id: "researcher",
  name: "Researcher",
  title: "Research",
  roleDescription: "Find and verify information.",
  avatarSeed: "researcher",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
  hasCallbackToken: false,
  hidden: false,
  systemOwned: false,
  canManage: true,
  mine: true,
};

function draw(onOpenSettings: () => void) {
  const root = createRootRoute({ component: Outlet });
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => (
      <AgentSettingsMenu agent={AGENT} onOpenSettings={onOpenSettings} />
    ),
  });
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/new",
    component: () => <p>New channel</p>,
  });
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createRouter({
    history,
    routeTree: root.addChildren([index, channel]),
  });
  const view = render(<RouterProvider router={router as never} />);
  return { view, router };
}

async function openMenu(view: ReturnType<typeof render>) {
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(
    await view.findByRole("button", { name: "Open settings for Researcher" }),
  );
  return user;
}

test("opens the selected agent's settings from the three-dot menu", async () => {
  let opened = 0;
  const { view } = draw(() => {
    opened += 1;
  });
  const user = await openMenu(view);

  await user.click(await view.findByRole("menuitem", { name: "Agent settings" }));

  expect(opened).toBe(1);
});

test("starts a channel with the selected agent", async () => {
  const { view, router } = draw(() => {});
  const user = await openMenu(view);

  await user.click(await view.findByRole("menuitem", { name: "Start channel" }));

  await waitFor(() => {
    expect(router.state.location.pathname).toBe("/channel/new");
    expect(router.state.location.search).toEqual({ agent: "researcher" });
  });
});
