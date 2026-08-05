/**
 * Races the provisioning key step's account-index read against a caller-
 * supplied timeout (buzz#128).
 *
 * The read itself (`getManagedAgentAccountIndex`, a Tauri IPC call) can
 * reject or simply never resolve — the dialog must show the same "something
 * is wrong, retry" state either way rather than spinning forever on
 * "Waiting for the agent's payment key to be assigned…". Isolated from React
 * and Tauri so it can be unit tested with a fake clock/fake read, mirroring
 * `liveSwitchOutcome.ts`'s inject-the-scheduler idiom.
 */
export type AccountIndexReadOutcome =
  | { kind: "ok"; accountIndex: number | null }
  | { kind: "error"; message: string }
  | { kind: "timeout" };

export async function readAccountIndexWithTimeout({
  read,
  scheduleTimeout,
}: {
  /** The account-index read itself — resolves `null` if never assigned. */
  read: () => Promise<number | null>;
  /** Schedule the stall fallback; returns a cancel function. */
  scheduleTimeout: (onTimeout: () => void) => () => void;
}): Promise<AccountIndexReadOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const cancelTimeout = scheduleTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    });

    read()
      .then((accountIndex) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        resolve({ kind: "ok", accountIndex });
      })
      .catch((error: unknown) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        resolve({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });
}
