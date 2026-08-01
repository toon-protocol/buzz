use crate::error::CliError;
use crate::sidecar::SidecarClient;
use crate::validate::{read_or_stdin, validate_content_size, validate_uuid};
use crate::ToonCmd;

/// `kind:9` — plain channel message, exactly as desktop's public-channel
/// write path publishes it (see `desktop/src/shared/api/eventWrites.ts`
/// `sendStreamMessage` and `buzz-sdk::builders::build_message`). Using the
/// same kind and the same `["h", <channel>]` tag is what makes this land in
/// desktop clients' timelines rather than a shape they silently ignore.
const KIND_CHANNEL_MESSAGE: u16 = 9;

/// The devnet faucet mentioned in the sidecar onboarding hint below — see
/// `desktop/src/shared/api/toonTransportConfig.ts`'s `TOON_DEVNET_DEFAULTS`
/// for the same URL used elsewhere in this repo. Confirmed live 2026-08-01:
/// its `evm` (Base Sepolia) leg drips BOTH native gas and the USDC settlement
/// token in one self-serve call, so it alone is enough to open a channel from
/// nothing. The `solana` and `mina` legs are USDC-only (see
/// `toon-client/packages/client/src/faucet.ts`) and expect the wallet to
/// already hold native gas — worth knowing before assuming any chain works
/// turnkey.
const DEVNET_FAUCET_URL: &str = "https://faucet.devnet.toonprotocol.dev";

pub async fn dispatch(cmd: &ToonCmd, sidecar_url: &str) -> Result<(), CliError> {
    let client = SidecarClient::new(sidecar_url.to_string())?;

    match cmd {
        ToonCmd::Status => cmd_status(&client).await,
        ToonCmd::Send { channel, content } => cmd_send(&client, channel, content).await,
    }
}

async fn cmd_status(client: &SidecarClient) -> Result<(), CliError> {
    let status = client.status().await?;

    let mut out = serde_json::to_value(&status).map_err(|e| CliError::Other(e.to_string()))?;
    if !status.ready {
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "hint".to_string(),
                serde_json::Value::String(format!(
                    "sidecar is not ready to pay for writes yet — if it has no funded \
channel, fund identity {} at {DEVNET_FAUCET_URL} (its evm/Base-Sepolia leg \
drips both gas and USDC in one call; solana/mina are USDC-only and expect \
gas already), then run the sidecar's own onboarding. This CLI does not \
manage mnemonics or open channels itself.",
                    status.identity.nostr_pubkey
                )),
            );
        }
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&out).map_err(|e| CliError::Other(e.to_string()))?
    );
    Ok(())
}

async fn cmd_send(client: &SidecarClient, channel: &str, content: &str) -> Result<(), CliError> {
    validate_uuid(channel)?;
    let content = read_or_stdin(content)?;
    validate_content_size(&content)?;
    if content.trim().is_empty() {
        return Err(CliError::Usage("content must not be empty".into()));
    }

    let receipt = client
        .publish_unsigned(
            KIND_CHANNEL_MESSAGE,
            content,
            vec![vec!["h".to_string(), channel.to_string()]],
        )
        .await?;

    println!(
        "{}",
        serde_json::to_string_pretty(&receipt).map_err(|e| CliError::Other(e.to_string()))?
    );
    Ok(())
}
