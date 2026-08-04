//! Git credential helper env vars for a spawned agent (buzz#100 extraction).
//!
//! Agents need to clone/push repos hosted on the Buzz relay's git server,
//! which authenticates via NIP-98. The `git-credential-nostr` binary signs
//! auth events using the agent's nostr key. Configured via `GIT_CONFIG_COUNT`
//! env vars (ephemeral, no filesystem writes) scoped to the relay's git URL
//! so we don't interfere with other remotes (e.g. GitHub).

use std::path::Path;

/// Builds the env vars that wire `git-credential-nostr` as the credential
/// helper for `relay_http_url`. Returns `None` when `cred_helper` is `None`
/// (binary not found) — the caller is responsible for logging that case,
/// since it needs agent-identifying context this pure function doesn't have.
///
/// `NOSTR_PRIVATE_KEY` mirrors `BUZZ_PRIVATE_KEY` — keep in sync.
pub(crate) fn build_git_credential_env(
    cred_helper: Option<&Path>,
    relay_http_url: &str,
    private_key_nsec: &str,
) -> Option<Vec<(&'static str, String)>> {
    let helper = cred_helper?.to_string_lossy().replace('\\', "/");
    Some(vec![
        ("NOSTR_PRIVATE_KEY", private_key_nsec.to_string()),
        ("GIT_TERMINAL_PROMPT", "0".to_string()),
        ("GIT_CONFIG_COUNT", "2".to_string()),
        (
            "GIT_CONFIG_KEY_0",
            format!("credential.{relay_http_url}/git.helper"),
        ),
        ("GIT_CONFIG_VALUE_0", helper),
        (
            "GIT_CONFIG_KEY_1",
            format!("credential.{relay_http_url}/git.useHttpPath"),
        ),
        ("GIT_CONFIG_VALUE_1", "true".to_string()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_none_when_helper_not_found() {
        assert!(build_git_credential_env(None, "https://relay.example", "nsec1x").is_none());
    }

    #[test]
    fn scopes_git_config_keys_to_the_relay_url() {
        let path = Path::new("/usr/local/bin/git-credential-nostr");
        let env = build_git_credential_env(Some(path), "https://relay.example", "nsec1x").unwrap();

        assert!(env.contains(&(
            "GIT_CONFIG_KEY_0",
            "credential.https://relay.example/git.helper".to_string()
        )));
        assert!(env.contains(&(
            "GIT_CONFIG_KEY_1",
            "credential.https://relay.example/git.useHttpPath".to_string()
        )));
        assert!(env.contains(&("GIT_CONFIG_VALUE_1", "true".to_string())));
        assert!(env.contains(&("NOSTR_PRIVATE_KEY", "nsec1x".to_string())));
    }

    #[test]
    fn normalizes_windows_backslashes_in_the_helper_path() {
        let path = Path::new(r"C:\Program Files\buzz\git-credential-nostr.exe");
        let env = build_git_credential_env(Some(path), "https://relay.example", "nsec1x")
            .expect("helper present");
        let value_0 = env
            .iter()
            .find(|(key, _)| *key == "GIT_CONFIG_VALUE_0")
            .map(|(_, value)| value.as_str())
            .unwrap();

        assert!(!value_0.contains('\\'));
    }
}
