/**
 * Serialize lifecycle mutations for one Bot while allowing different Bots to proceed in parallel.
 *
 * Supervisor HTTP handlers are concurrent. Without a per-Bot gate, Start/Ensure can race Stop/Reset
 * (and future checkpoint/restore), so one request can recreate or start a container while another is
 * still tearing it down. The server has higher-level race recovery too, but the Docker owner should
 * not manufacture contradictory lifecycle operations for the same Bot in the first place.
 */
export type ComputerLifecycleLock = {
  run<T>(botId: string, work: () => Promise<T>): Promise<T>;
};

export function createComputerLifecycleLock(): ComputerLifecycleLock {
  const tails = new Map<string, Promise<void>>();

  return {
    async run<T>(botId: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(botId) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(botId, tail);

      await previous;
      try {
        return await work();
      } finally {
        release();
        if (tails.get(botId) === tail) {
          tails.delete(botId);
        }
      }
    },
  };
}
