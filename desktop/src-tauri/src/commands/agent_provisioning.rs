//! Frontend-facing read of the account index `create_managed_agent` already
//! assigns (buzz#79) — the desktop UI needs it to derive an agent's TOON
//! payment address (owner mnemonic + this index) before it can provision
//! that agent's wallet (buzz#74).

use tauri::AppHandle;

#[tauri::command]
pub fn get_managed_agent_account_index(
    pubkey: String,
    app: AppHandle,
) -> Result<Option<u32>, String> {
    crate::managed_agents::find_account_index(&app, &pubkey)
}
