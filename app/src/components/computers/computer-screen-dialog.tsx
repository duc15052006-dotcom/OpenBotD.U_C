import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  type ControlState,
  readControl,
  releaseControl,
  sendHumanInput,
  supplySecret,
  takeControl,
} from "@/lib/computers/control";
import { readScreenshot, type Screenshot } from "@/lib/computers/screen";

/**
 * A human view into one Bot's browser.
 *
 * Opening this dialog starts only the viewer: the Computer is already started by the caller.
 * Closing it stops polling immediately and, if the person held the wheel, returns control to the Bot.
 * The Computer itself keeps running and its browser/profile/workspace are untouched.
 */
export function ComputerScreenDialog({
  botId,
  botName,
  open,
  onOpenChange,
}: {
  botId: string;
  botName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [frame, setFrame] = useState<Screenshot | null>(null);
  const [control, setControl] = useState<ControlState | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [privateText, setPrivateText] = useState("");
  const [secretText, setSecretText] = useState("");
  const [changingControl, setChangingControl] = useState(false);
  const [sendingSecret, setSendingSecret] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;

    const refresh = async () => {
      const [screen, nextControl] = await Promise.all([
        readScreenshot(botId),
        readControl(botId),
      ]);
      if (!alive) return;

      if (screen.frame) {
        setFrame(screen.frame);
        setProblem(null);
      } else if (screen.error) {
        setProblem(screen.error);
      }
      if (nextControl) setControl(nextControl);
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [botId, open]);

  const changeOpen = (next: boolean) => {
    if (!next) {
      setPrivateText("");
      setSecretText("");
      // A closed viewer must never strand the Bot behind a human takeover nobody can see.
      if (control?.holder === "human") void releaseControl(botId);
    }
    onOpenChange(next);
  };

  const take = async () => {
    setChangingControl(true);
    setProblem(null);
    try {
      const next = await takeControl(botId);
      if (!next) throw new Error("The computer did not confirm the handover.");
      setControl(next);
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "You could not take control of this computer.",
      );
    } finally {
      setChangingControl(false);
    }
  };

  const release = async () => {
    setChangingControl(true);
    setProblem(null);
    try {
      const next = await releaseControl(botId);
      if (!next) throw new Error("The computer did not confirm the handover.");
      setControl(next);
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Control could not be returned to the coworker.",
      );
    } finally {
      setChangingControl(false);
    }
  };

  const typePrivately = () => {
    if (!privateText || control?.holder !== "human") return;
    sendHumanInput(botId, "type", { text: privateText });
    setPrivateText("");
  };

  const enterRequestedSecret = async () => {
    if (!secretText || !control?.secretWanted) return;
    setSendingSecret(true);
    setProblem(null);
    try {
      const result = await supplySecret(botId, secretText);
      if (!result.ok) {
        throw new Error(result.error ?? "That value could not be entered.");
      }
      setSecretText("");
      const next = await readControl(botId);
      if (next) setControl(next);
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "That value could not be entered.",
      );
    } finally {
      setSendingSecret(false);
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent className="max-h-[92svh] sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{botName}&apos;s screen</DialogTitle>
          <DialogDescription>
            Watch this coworker&apos;s browser. Take control only when you need
            to sign in or intervene; closing this screen does not stop the
            Computer.
          </DialogDescription>
        </DialogHeader>

        {problem ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
            role="alert"
          >
            {problem}
          </p>
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-h-0 overflow-auto rounded-lg border border-border bg-black">
            {frame ? (
              <button
                aria-label={
                  control?.holder === "human"
                    ? "Computer screen. Click to interact."
                    : "Computer screen. Take control to interact."
                }
                className="block w-full cursor-default border-0 bg-transparent p-0 disabled:cursor-default"
                disabled={control?.holder !== "human"}
                onClick={(event) => {
                  if (control?.holder !== "human") return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x =
                    ((event.clientX - rect.left) / rect.width) * frame.width;
                  const y =
                    ((event.clientY - rect.top) / rect.height) * frame.height;
                  sendHumanInput(botId, "click", { x, y });
                }}
                type="button"
              >
                <img
                  alt={`Live browser screen for ${botName}`}
                  className="block h-auto w-full select-none"
                  draggable={false}
                  src={`data:image/png;base64,${frame.base64}`}
                />
              </button>
            ) : (
              <div className="flex min-h-[420px] items-center justify-center p-6 text-center text-sm text-white/70">
                Waiting for the browser screen…
              </div>
            )}
          </div>

          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div className="rounded-lg border border-border p-3">
              <p className="font-medium text-sm">
                {control?.holder === "human"
                  ? "You have control"
                  : "Coworker has control"}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {control?.requested && control.reason
                  ? control.reason
                  : control?.holder === "human"
                    ? "Mouse and keyboard input goes directly to the browser."
                    : "Watching does not interrupt the coworker."}
              </p>
              <div className="mt-3">
                {control?.holder === "human" ? (
                  <Button
                    disabled={changingControl}
                    onClick={() => void release()}
                    size="sm"
                    variant="outline"
                  >
                    Return control
                  </Button>
                ) : (
                  <Button
                    disabled={changingControl}
                    onClick={() => void take()}
                    size="sm"
                  >
                    Take control
                  </Button>
                )}
              </div>
            </div>

            {frame?.url ? (
              <div className="rounded-lg border border-border p-3">
                <p className="font-medium text-xs">Current page</p>
                <p
                  className="mt-1 break-all text-muted-foreground text-xs"
                  title={frame.url}
                >
                  {frame.url}
                </p>
              </div>
            ) : null}

            {control?.secretWanted ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="font-medium text-sm">Private value requested</p>
                <p className="mt-1 text-muted-foreground text-xs">
                  {control.secretWanted}. This value is sent straight to the
                  browser field and is not echoed back to the Bot.
                </p>
                <Input
                  autoComplete="off"
                  className="mt-3"
                  onChange={(event) => setSecretText(event.target.value)}
                  placeholder="Enter privately"
                  type="password"
                  value={secretText}
                />
                <Button
                  className="mt-2"
                  disabled={!secretText || sendingSecret}
                  onClick={() => void enterRequestedSecret()}
                  size="sm"
                >
                  {sendingSecret ? "Entering…" : "Enter securely"}
                </Button>
              </div>
            ) : null}

            <div className="rounded-lg border border-border p-3">
              <p className="font-medium text-sm">Keyboard</p>
              <p className="mt-1 text-muted-foreground text-xs">
                Click a field on the screen first. Text typed here is not
                returned to the model or recorded per keystroke.
              </p>
              <Input
                autoComplete="off"
                className="mt-3"
                disabled={control?.holder !== "human"}
                onChange={(event) => setPrivateText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && privateText) {
                    event.preventDefault();
                    typePrivately();
                  }
                }}
                placeholder="Type into focused field"
                type="password"
                value={privateText}
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  disabled={control?.holder !== "human" || !privateText}
                  onClick={typePrivately}
                  size="sm"
                >
                  Type
                </Button>
                {["Tab", "Enter", "Escape"].map((key) => (
                  <Button
                    disabled={control?.holder !== "human"}
                    key={key}
                    onClick={() => sendHumanInput(botId, "key", { key })}
                    size="sm"
                    variant="outline"
                  >
                    {key === "Escape" ? "Esc" : key}
                  </Button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="font-medium text-sm">Scroll</p>
              <div className="mt-2 flex gap-2">
                <Button
                  disabled={control?.holder !== "human"}
                  onClick={() =>
                    sendHumanInput(botId, "scroll", { deltaY: -600 })
                  }
                  size="sm"
                  variant="outline"
                >
                  Up
                </Button>
                <Button
                  disabled={control?.holder !== "human"}
                  onClick={() =>
                    sendHumanInput(botId, "scroll", { deltaY: 600 })
                  }
                  size="sm"
                  variant="outline"
                >
                  Down
                </Button>
              </div>
            </div>
          </aside>
        </div>

        <DialogFooter>
          <span className="mr-auto text-muted-foreground text-xs">
            Stop viewing only closes this screen. The Agent Computer keeps
            running.
          </span>
          <Button onClick={() => changeOpen(false)} size="sm" variant="outline">
            Stop viewing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
