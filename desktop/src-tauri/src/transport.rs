//! Configuration for the frontend's event-transport seam.
//!
//! The seam (`shared/api/eventTransport.ts`) can carry writes over the relay
//! session or over TOON, and which one — plus every endpoint, key and chain
//! the TOON side needs — is chosen at runtime rather than compiled in.
//!
//! The renderer cannot read the process environment, so the values are
//! resolved here for the same reason `BUZZ_RELAY_URL` is: a build-time
//! constant cannot be flipped on an installed app, and pointing a shipped
//! build at a devnet is exactly what this switch exists for.

use std::collections::BTreeMap;

use crate::relay::configured_env_var;

/// Environment keys the frontend may read.
///
/// A closed list, not a view of the process environment: `BUZZ_TOON_MNEMONIC`
/// is a spending key and `BUZZ_CHANNEL_KEYS` carries channel keys, so what
/// crosses into JS stays a deliberate edit here.
const TRANSPORT_ENV_KEYS: &[&str] = &[
    "BUZZ_TRANSPORT",
    // Not TOON-specific: channel-key encryption sits above the transport seam
    // and applies on the relay transport too. It rides this bridge because
    // this is the only path the renderer has to the process environment.
    "BUZZ_CHANNEL_KEYS",
    "BUZZ_TOON_PROXY_URL",
    "BUZZ_TOON_RELAY_URL",
    "BUZZ_TOON_DESTINATION",
    "BUZZ_TOON_MNEMONIC",
    "BUZZ_TOON_ACCOUNT_INDEX",
    "BUZZ_TOON_CHAIN",
    "BUZZ_TOON_CHAIN_RPC_URL",
    "BUZZ_TOON_TOKEN_NETWORK",
    "BUZZ_TOON_PREFERRED_TOKEN",
];

/// The transport environment, with unset and blank keys omitted.
///
/// Omitting blanks rather than passing them through keeps the defaulting rule
/// in one place: the frontend treats an absent key as "use the default", and
/// an empty env var means the operator did not set it.
pub fn transport_env() -> BTreeMap<String, String> {
    TRANSPORT_ENV_KEYS
        .iter()
        .filter_map(|key| configured_env_var(key).map(|value| ((*key).to_string(), value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{transport_env, TRANSPORT_ENV_KEYS};

    #[test]
    fn every_exposed_key_is_buzz_scoped() {
        // The frontend gets a closed list; a key that is not ours would leak
        // unrelated process environment into the renderer.
        for key in TRANSPORT_ENV_KEYS {
            assert!(key.starts_with("BUZZ_"), "unexpected exposed key: {key}");
        }
    }

    #[test]
    fn the_transport_switch_is_exposed() {
        assert!(TRANSPORT_ENV_KEYS.contains(&"BUZZ_TRANSPORT"));
    }

    #[test]
    fn unset_keys_are_omitted_rather_than_blank() {
        // Not `env::set_var` — tests share a process. Whatever is set, no value
        // in the map may be empty, because empty means "unset" to the frontend.
        for (key, value) in transport_env() {
            assert!(!value.is_empty(), "{key} was exposed as an empty string");
        }
    }
}
