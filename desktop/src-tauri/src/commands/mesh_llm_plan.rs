//! Pure decision helpers for the mesh-LLM commands: what a Share-compute
//! start/stop is allowed to do to the single runtime slot. Split from
//! `mesh_llm.rs` to keep that file under the desktop file-size ratchet;
//! unit-tested from `mesh_llm_tests.rs` via the parent's scope.

use crate::mesh_llm;

/// Whether the Share-compute "stop sharing" path (`mesh_stop_node`) should tear
/// down the runtime currently occupying the single slot.
///
/// Serve nodes (this machine SHARING compute) are torn down. Client nodes (this
/// machine CONSUMING a peer's compute) share the same slot and MUST be left
/// running — stopping "Share compute" must never kill a consume session the
/// user didn't start from this switch.
pub(crate) fn share_stop_should_teardown(mode: mesh_llm::MeshNodeMode) -> bool {
    matches!(mode, mesh_llm::MeshNodeMode::Serve)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MeshStartPlan {
    Start,
    RestartToReplaceClient,
    RejectOccupied,
}

pub(crate) fn mesh_start_plan(
    requested_mode: mesh_llm::MeshNodeMode,
    existing_mode: Option<mesh_llm::MeshNodeMode>,
) -> MeshStartPlan {
    match (requested_mode, existing_mode) {
        (_, None) => MeshStartPlan::Start,
        (mesh_llm::MeshNodeMode::Serve, Some(mesh_llm::MeshNodeMode::Client)) => {
            MeshStartPlan::RestartToReplaceClient
        }
        _ => MeshStartPlan::RejectOccupied,
    }
}
