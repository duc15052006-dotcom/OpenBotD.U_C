import {
  afterAll,
  afterEach,
  beforeAll,
  expect,
  mock,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentActionsMenu } from "@/components/agents/agent-actions-menu";

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("the agent menu keeps settings and channel actions behind one accessible trigger", async () => {
  const openSettings = mock(() => {});
  const startChannel = mock(() => {});
  const view = render(
    <div className="relative">
      <AgentActionsMenu
        agentName="Researcher"
        onOpenSettings={openSettings}
        onStartChannel={startChannel}
      />
    </div>,
  );
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });

  await user.click(
    view.getByRole("button", { name: "Actions for Researcher" }),
  );
  await user.click(await view.findByRole("menuitem", { name: "Settings" }));

  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(startChannel).not.toHaveBeenCalled();

  await user.click(
    view.getByRole("button", { name: "Actions for Researcher" }),
  );
  await user.click(await view.findByRole("menuitem", { name: "Start channel" }));

  expect(startChannel).toHaveBeenCalledTimes(1);
});
