import { invokeTauri } from "@/shared/api/tauri";

/**
 * Transport-selection environment (`BUZZ_TRANSPORT`, `BUZZ_TOON_*`).
 *
 * A closed list resolved in Rust, not a view of the process environment — see
 * `src-tauri/src/transport.rs`. Keys the operator did not set are omitted, so
 * an absent key means "use the default".
 */
export function getTransportEnv(): Promise<Record<string, string>> {
  return invokeTauri<Record<string, string>>("get_transport_env");
}
