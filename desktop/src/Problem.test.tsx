import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let invokeCalls: Array<{ command: string; args?: unknown }> = [];
let invokeHandler = async (
  _command: string,
  _args?: unknown,
): Promise<unknown> => null;

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: unknown) => {
    invokeCalls.push({ command, args });
    return invokeHandler(command, args);
  },
}));

const { Failure } = await import("./Problem");

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  invokeCalls = [];
  invokeHandler = async () => null;
  cleanup();
});
afterAll(() => GlobalRegistrator.unregister());

test("problem_ui_has_no_credential_restore_action", () => {
  const view = render(
    <Failure
      problem={{
        said: "Synthetic credential failure.",
        detail: "synthetic path refusal",
      }}
    />,
  );

  expect(view.getByRole("alert").textContent).toContain(
    "Synthetic credential failure.",
  );
  expect(
    view.queryByRole("button", { name: /restore|credential/i }),
  ).toBeNull();
  expect(view.getByRole("button", { name: "Run diagnostics" })).toBeTruthy();
  // Diagnostics are explicitly user-invoked; merely rendering a failure reads nothing.
  expect(invokeCalls).toEqual([]);
});

test("diagnostics_reads_only_safe_status_commands_after_the_person_asks", async () => {
  invokeHandler = async (command, args) => {
    switch (command) {
      case "detect_engine":
        return {
          engine: "podman",
          responding: true,
          engine_socket: null,
          detail: "Podman is ready.",
        };
      case "selected_root":
        return "C:\\OpenBot";
      case "default_root":
        return "C:\\Users\\OpenBot";
      case "last_failure":
        return { said: "Previous startup stopped." };
      case "already_running":
        expect(args).toEqual({ root: "C:\\OpenBot" });
        return true;
      default:
        throw new Error(`Unexpected diagnostics command: ${command}`);
    }
  };

  const view = render(
    <Failure problem={{ said: "Synthetic startup failure." }} />,
  );

  await userEvent.click(view.getByRole("button", { name: "Run diagnostics" }));

  await waitFor(() => {
    expect(view.getByText(/Engine: podman/)).toBeTruthy();
  });
  expect(view.getByText(/Stack running: true/)).toBeTruthy();
  expect(view.getByText(/Last failure: Previous startup stopped\./)).toBeTruthy();

  expect(invokeCalls).toEqual([
    { command: "detect_engine", args: undefined },
    { command: "selected_root", args: undefined },
    { command: "default_root", args: undefined },
    { command: "last_failure", args: undefined },
    { command: "already_running", args: { root: "C:\\OpenBot" } },
  ]);
  expect(
    invokeCalls.some((call) =>
      /credential|provider|configured|api[_-]?key|env/i.test(call.command),
    ),
  ).toBe(false);
});
