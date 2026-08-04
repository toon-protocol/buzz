//! Delete-time guards, split from `agents.rs` (file-size guard).

use crate::managed_agents::{BackendKind, ManagedAgentRecord};

/// Reject deletion of a deployed remote agent unless the caller explicitly
/// opts in via `force_remote_delete`.
///
/// Turns "don't orphan remote infra" from a UI convention into a backend
/// invariant — a buggy or compromised IPC caller cannot silently orphan a
/// live remote deployment. The frontend sends `force_remote_delete: true`
/// only after the user confirms the orphan warning.
pub(super) fn reject_undeployed_remote_delete(
    record: Option<&ManagedAgentRecord>,
    force_remote_delete: bool,
) -> Result<(), String> {
    let Some(record) = record else {
        return Ok(());
    };
    if record.backend != BackendKind::Local
        && record.backend_agent_id.is_some()
        && !force_remote_delete
    {
        return Err(
            "cannot delete a deployed remote agent without force_remote_delete: true".to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::managed_agents::RespondTo;
    use std::collections::BTreeMap;

    fn record(backend: BackendKind, backend_agent_id: Option<&str>) -> ManagedAgentRecord {
        ManagedAgentRecord {
            pubkey: "agent".to_string(),
            name: "Agent".to_string(),
            persona_id: None,
            private_key_nsec: "".to_string(),
            auth_tag: None,
            relay_url: "ws://localhost:3000".to_string(),
            avatar_url: None,
            acp_command: "buzz-acp".to_string(),
            agent_command: "goose".to_string(),
            agent_command_override: None,
            agent_args: vec![],
            mcp_command: "".to_string(),
            turn_timeout_seconds: 300,
            idle_timeout_seconds: None,
            max_turn_duration_seconds: None,
            parallelism: 1,
            system_prompt: None,
            model: None,
            provider: None,
            persona_source_version: None,
            env_vars: BTreeMap::new(),
            start_on_app_launch: false,
            runtime_pid: None,
            backend,
            backend_agent_id: backend_agent_id.map(str::to_string),
            provider_binary_path: None,
            team_id: None,
            persona_team_dir: None,
            persona_name_in_team: None,
            created_at: "".to_string(),
            updated_at: "".to_string(),
            last_started_at: None,
            last_stopped_at: None,
            last_exit_code: None,
            last_error: None,
            last_error_code: None,
            respond_to: RespondTo::OwnerOnly,
            respond_to_allowlist: vec![],
            display_name: None,
            slug: None,
            runtime: None,
            name_pool: vec![],
            is_builtin: false,
            is_active: true,
            shared: false,
            source_team: None,
            source_team_persona_slug: None,
            catalog_source: None,
            relay_mesh: None,
            auto_restart_on_config_change: false,
            definition_respond_to: None,
            definition_respond_to_allowlist: vec![],
            definition_parallelism: None,
        }
    }

    fn remote_record(backend_agent_id: Option<&str>) -> ManagedAgentRecord {
        record(
            BackendKind::Provider {
                id: "some-provider".to_string(),
                config: serde_json::Value::Null,
            },
            backend_agent_id,
        )
    }

    #[test]
    fn allows_deleting_a_local_agent_without_force() {
        let record = record(BackendKind::Local, None);
        assert!(reject_undeployed_remote_delete(Some(&record), false).is_ok());
    }

    #[test]
    fn allows_deleting_an_undeployed_remote_agent_without_force() {
        let record = remote_record(None);
        assert!(reject_undeployed_remote_delete(Some(&record), false).is_ok());
    }

    #[test]
    fn rejects_deleting_a_deployed_remote_agent_without_force() {
        let record = remote_record(Some("deploy-123"));
        assert!(reject_undeployed_remote_delete(Some(&record), false).is_err());
    }

    #[test]
    fn allows_deleting_a_deployed_remote_agent_when_forced() {
        let record = remote_record(Some("deploy-123"));
        assert!(reject_undeployed_remote_delete(Some(&record), true).is_ok());
    }

    #[test]
    fn allows_a_missing_record_through() {
        assert!(reject_undeployed_remote_delete(None, false).is_ok());
    }
}
