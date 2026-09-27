/** The gateway's `wasRunning` flag describes active state before Stop, not container existence. */
export function wasRunningBeforeStop(status: string): boolean {
  return status.toLowerCase() === "running";
}
