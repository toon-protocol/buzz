//! `buzz toon` — the agent-member's own surface on a TOON community.
//!
//! buzz#15 gave an agent a paid write through the local `toon-clientd`
//! sidecar. buzz#19 makes that agent a *member of a private channel*: it is
//! admitted by the standard add-member flow (an admin gift-wraps the channel
//! key to the identity the sidecar owns), it reads the encrypted history, and
//! it seals its own replies — paying for each from its own channel.
//!
//! ## Who holds what
//!
//! - The **sidecar** is the identity custodian. It holds the agent's nostr
//!   secret key, its wallet, and its payment channel. It signs, it pays, and
//!   it is the only thing that can open a NIP-59 gift wrap addressed to the
//!   agent (`POST /nip59-unwrap`). It never sees a channel key.
//! - The **agent** (this CLI) holds channel keys, in
//!   [`crate::agent_keystore`], and does its own NIP-44 sealing. `send`
//!   therefore hands the sidecar already-sealed content plus the marker tag;
//!   the sidecar signs the shell it is given.
//! - The **relay** enforces nothing (ADR 0001). Reads are free and public;
//!   every trust decision — is this sender an admin? is this epoch current? —
//!   is made here, from signature-verified events.
//!
//! ## No agent-specific path
//!
//! Nothing below asks whether a member is an agent. Admission is
//! `channel_key_grant::accept_grant`, the port of the same check a desktop
//! client runs on itself; rotation locks an agent out exactly as it locks out
//! a human, by giving it no wrap for the new epoch and leaving its ring one
//! epoch behind.

use buzz_channel_crypto::{channel_key_id, is_sealed, key_id_from_tags, seal, ChannelKey};
use nostr::Event;
use serde_json::{json, Value};

use crate::agent_keystore::{Adoption, AgentKeystore};
use crate::channel_admins::{
    channel_admin_list_filter, resolve_channel_admin_list, tags_as_strings, ChannelAdminList,
};
use crate::channel_key_grant::{accept_grant, parse_key_rumor, GrantRejection, GIFT_WRAP_KIND};
use crate::error::CliError;
use crate::sidecar::SidecarClient;
use crate::toon_relay::{self, channel_message_filter, gift_wrap_filter};
use crate::validate::{read_or_stdin, validate_content_size, validate_uuid};
use crate::ToonCmd;

/// `kind:9` — plain channel message, exactly as desktop's public-channel
/// write path publishes it (see `desktop/src/shared/api/eventWrites.ts`
/// `sendStreamMessage` and `buzz-sdk::builders::build_message`). Using the
/// same kind and the same `["h", <channel>]` tag is what makes this land in
/// desktop clients' timelines rather than a shape they silently ignore.
/// Encrypted messages are the *same* kind: buzz#12 seals the content, not the
/// envelope.
const KIND_CHANNEL_MESSAGE: u16 = 9;

/// How many admin-list events one read pulls. Matches
/// `channelAdminListFilter`'s default; the filter is not scoped by channel,
/// because an agent must be able to validate a key wrapped for a channel it
/// has never heard of.
const ADMIN_LIST_LIMIT: u32 = 500;

/// What desktop renders in place of a message this client cannot open.
/// Matches `channelMessageCrypto.ts`'s `LOCKED_MESSAGE_PLACEHOLDER`.
const LOCKED_MESSAGE_PLACEHOLDER: &str =
    "[Encrypted message — this client does not have the channel key.]";

/// Escape hatch for [`plan_send`]'s fail-closed default, as an env var rather
/// than a flag so it is a deliberate configuration of an agent's environment
/// and not something that lands in a one-off command line by muscle memory.
const ASSUME_PUBLIC_ENV: &str = "BUZZ_TOON_ASSUME_PUBLIC";

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

/// Where the three `buzz toon` collaborators live: the sidecar that owns the
/// identity, the relay that is read for free, and the file the agent keeps its
/// channel keys in.
pub struct ToonContext<'a> {
    pub sidecar_url: &'a str,
    pub relay_url: &'a str,
    pub keystore_path: Option<&'a str>,
}

pub async fn dispatch(cmd: &ToonCmd, ctx: &ToonContext<'_>) -> Result<(), CliError> {
    let client = SidecarClient::new(ctx.sidecar_url.to_string())?;

    match cmd {
        ToonCmd::Status => cmd_status(&client).await,
        ToonCmd::Send { channel, content } => cmd_send(&client, ctx, channel, content).await,
        ToonCmd::Inbox { limit } => cmd_inbox(&client, ctx, *limit).await,
        ToonCmd::Read {
            channel,
            limit,
            since,
        } => cmd_read(ctx, channel, *limit, *since).await,
        ToonCmd::Keys => cmd_keys(ctx),
        ToonCmd::SearchAgent {
            port,
            index,
            poll_interval,
            page_size,
            inbox_limit,
            once,
        } => {
            crate::search_agent::run(crate::search_agent::SearchAgentOptions {
                sidecar_url: ctx.sidecar_url,
                relay_url: ctx.relay_url,
                keystore_path: ctx.keystore_path,
                index_path: index.as_deref(),
                // Loopback is not a default the caller may override: the
                // endpoint serves decrypted private text, and signed queries
                // (buzz#179) harden that boundary rather than replace it.
                // Only the port is configurable.
                bind: std::net::SocketAddr::from(([127, 0, 0, 1], *port)),
                poll_interval: std::time::Duration::from_secs(*poll_interval),
                page_size: *page_size,
                inbox_limit: *inbox_limit,
                once: *once,
            })
            .await
        }
        ToonCmd::WorkflowAgent {
            workflows,
            state,
            poll_interval,
            page_size,
            inbox_limit,
            once,
        } => {
            crate::workflow_agent::run(crate::workflow_agent::WorkflowAgentOptions {
                sidecar_url: ctx.sidecar_url,
                relay_url: ctx.relay_url,
                keystore_path: ctx.keystore_path,
                state_path: state.as_deref(),
                workflows_path: std::path::Path::new(workflows),
                poll_interval: std::time::Duration::from_secs(*poll_interval),
                page_size: *page_size,
                inbox_limit: *inbox_limit,
                once: *once,
            })
            .await
        }
    }
}

fn print_json(value: &Value) -> Result<(), CliError> {
    println!(
        "{}",
        serde_json::to_string_pretty(value).map_err(|e| CliError::Other(e.to_string()))?
    );
    Ok(())
}

fn open_keystore(ctx: &ToonContext<'_>) -> Result<AgentKeystore, CliError> {
    AgentKeystore::open(AgentKeystore::resolve_path(ctx.keystore_path)?)
}

async fn cmd_status(client: &SidecarClient) -> Result<(), CliError> {
    let status = client.status().await?;

    let mut out = serde_json::to_value(&status).map_err(|e| CliError::Other(e.to_string()))?;
    if !status.ready {
        if let Some(obj) = out.as_object_mut() {
            obj.insert(
                "hint".to_string(),
                Value::String(format!(
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

    print_json(&out)
}

// ─── inbox ───────────────────────────────────────────────────────────────────

/// Every kind:39100 event the relay will serve, in one read.
///
/// The filter is not scoped by channel (see [`ADMIN_LIST_LIMIT`]), so one
/// fetch answers every channel an inbox sweep encounters — re-reading per
/// channel would send the identical `REQ` N times for the same bytes. The
/// search agent's query-time authority refresh reads the same way
/// (`search_agent::resolve_admin_lists`), so the two share this one filter.
pub(crate) async fn fetch_admin_events(relay_url: &str) -> Result<Vec<Event>, CliError> {
    toon_relay::fetch(relay_url, channel_admin_list_filter(ADMIN_LIST_LIMIT)).await
}

/// Fold one channel's admin chain out of `events`.
///
/// `pinned_creator` is the root this agent already committed to for the
/// channel, if any: the first accepted root is remembered (TOFU, mirroring
/// `channelAdminListStore.ts`'s `pinnedCreators`) so a later backdated
/// impostor cannot re-root a channel the agent is already in.
fn resolve_admins(
    events: &[Event],
    channel_id: &str,
    pinned_creator: Option<&str>,
) -> Option<ChannelAdminList> {
    resolve_channel_admin_list(events, channel_id, pinned_creator)
}

/// What one inbox sweep did, as the JSON rows `buzz toon inbox` prints.
///
/// Returned rather than printed because the sweep has two callers now: the
/// one-shot command below, and the search agent's ingest loop (buzz#20), which
/// runs the identical admission logic on a timer and logs a summary instead.
/// A second implementation of "which keys may this agent adopt" is precisely
/// the thing that would grow an agent-specific backdoor by accident.
#[derive(Debug, Default)]
pub struct InboxSweep {
    pub wraps_seen: usize,
    pub accepted: Vec<Value>,
    pub skipped: Vec<Value>,
    pub promoted: Vec<Value>,
}

/// Fold every gift wrap addressed to `identity` into `keystore`, then
/// reconcile each held channel's sending epoch against its validated admin
/// list.
///
/// Mutates `keystore` in memory; saving is the caller's call, so a caller that
/// must commit other state in the same breath (the search agent commits its
/// index) controls the ordering.
pub async fn sweep_inbox(
    client: &SidecarClient,
    relay_url: &str,
    identity: &str,
    keystore: &mut AgentKeystore,
    limit: u32,
) -> Result<InboxSweep, CliError> {
    let ctx = ToonContext {
        sidecar_url: "",
        relay_url,
        keystore_path: None,
    };
    sweep_inbox_inner(client, &ctx, identity, keystore, limit).await
}

async fn cmd_inbox(
    client: &SidecarClient,
    ctx: &ToonContext<'_>,
    limit: u32,
) -> Result<(), CliError> {
    let status = client.status().await?;
    let identity = status.identity.nostr_pubkey.clone();

    let mut keystore = open_keystore(ctx)?;
    keystore.assert_identity(&identity)?;

    let sweep = sweep_inbox_inner(client, ctx, &identity, &mut keystore, limit).await?;
    keystore.save()?;

    let sending: Vec<Value> = keystore
        .channels()
        .map(|channel| {
            json!({
                "channel": channel,
                "sendingKeyId": keystore.sending_key(channel).as_ref().map(channel_key_id),
            })
        })
        .collect();

    print_json(&json!({
        "identity": identity,
        "keystore": keystore.path().display().to_string(),
        "wrapsSeen": sweep.wraps_seen,
        "accepted": sweep.accepted,
        "skipped": sweep.skipped,
        "promoted": sweep.promoted,
        "membership": sending,
    }))
}

async fn sweep_inbox_inner(
    client: &SidecarClient,
    ctx: &ToonContext<'_>,
    identity: &str,
    keystore: &mut AgentKeystore,
    limit: u32,
) -> Result<InboxSweep, CliError> {
    let wraps = toon_relay::fetch(ctx.relay_url, gift_wrap_filter(identity, limit)).await?;

    // One admin-list read for the whole sweep, folded per channel and cached:
    // an admin re-wrapping to twenty members produces twenty wraps naming one
    // channel, and every channel's chain comes out of the same fetch.
    let mut admin_events: Option<Vec<Event>> = None;
    let mut admin_lists: std::collections::HashMap<String, Option<ChannelAdminList>> =
        std::collections::HashMap::new();

    let mut accepted: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();

    for wrap in &wraps {
        let wrap_id = wrap.id.to_hex();
        // The filter asked for kind:1059, but a relay is not obliged to
        // honour a filter and this CLI is not obliged to believe it.
        if u64::from(wrap.kind.as_u16()) != GIFT_WRAP_KIND {
            skipped.push(json!({
                "wrapId": wrap_id,
                "reason": "not-a-gift-wrap",
                "detail": format!("kind {} is not a NIP-59 gift wrap", wrap.kind.as_u16()),
            }));
            continue;
        }
        let wrap_json = serde_json::to_value(wrap)
            .map_err(|e| CliError::Other(format!("could not re-encode wrap {wrap_id}: {e}")))?;

        let unwrapped = match client.nip59_unwrap(&wrap_json).await {
            Ok(unwrapped) => unwrapped,
            // 400 (malformed / not for us) and 422 (MAC failure) are the
            // ordinary cost of reading a public relay, not a reason to
            // abandon the sweep. Anything else — the sidecar being down, say
            // — is fatal, because every remaining wrap would fail the same
            // way and a "0 accepted" summary would read like an empty inbox.
            Err(CliError::Sidecar { status, error, .. }) if matches!(status, 400 | 422) => {
                skipped.push(json!({
                    "wrapId": wrap_id,
                    "reason": "unwrap-failed",
                    "detail": format!("sidecar returned {status} {error}"),
                }));
                continue;
            }
            Err(other) => return Err(other),
        };

        let grant = match parse_key_rumor(&unwrapped.rumor, &unwrapped.seal_pubkey) {
            Ok(grant) => grant,
            Err(rejection) => {
                skipped.push(rejection_json(&wrap_id, &rejection, None));
                continue;
            }
        };

        let pinned = keystore
            .pinned_creator(&grant.channel_id)
            .map(str::to_string);
        if !admin_lists.contains_key(&grant.channel_id) {
            let events = match &admin_events {
                Some(events) => events,
                None => admin_events.insert(fetch_admin_events(ctx.relay_url).await?),
            };
            let resolved = resolve_admins(events, &grant.channel_id, pinned.as_deref());
            admin_lists.insert(grant.channel_id.clone(), resolved);
        }
        let admin_list = admin_lists.get(&grant.channel_id).and_then(Option::as_ref);

        if let Err(rejection) = accept_grant(&grant, admin_list) {
            skipped.push(rejection_json(
                &wrap_id,
                &rejection,
                Some(&grant.channel_id),
            ));
            continue;
        }
        let list = admin_list.expect("accept_grant rejects a missing admin list");

        // TOFU: the root that first admitted this agent is the root forever.
        keystore.pin_creator(&grant.channel_id, &list.creator);
        let adoption = keystore.adopt(&grant.channel_id, grant.key);

        accepted.push(json!({
            "wrapId": wrap_id,
            "channel": grant.channel_id,
            "keyId": grant.key_id,
            "epoch": grant.epoch,
            "from": grant.sender,
            "adoption": match adoption {
                Adoption::FirstKey => "first-key",
                Adoption::Added => "added",
                Adoption::AlreadyHeld => "already-held",
            },
        }));
    }

    // Reconcile every channel, not only the ones a wrap named this run: a key
    // delivered before its rotation was announced sits at index 1 waiting for
    // the list to name it, and the run that sees the announcement may bring no
    // new wrap at all. Port of `channelKeyEpoch.ts`'s
    // `reconcileChannelKeyEpochs` — promote-only, never demote.
    let held: Vec<String> = keystore.channels().cloned().collect();
    let mut promoted: Vec<Value> = Vec::new();
    if !held.is_empty() {
        let events = match &admin_events {
            Some(events) => events,
            None => admin_events.insert(fetch_admin_events(ctx.relay_url).await?),
        };
        for channel_id in held {
            let Some(list) =
                resolve_admins(events, &channel_id, keystore.pinned_creator(&channel_id))
            else {
                continue;
            };
            let Some(key_id) = list.key_id else { continue };
            if keystore.promote(&channel_id, &key_id) {
                promoted.push(json!({
                    "channel": channel_id,
                    "sendingKeyId": key_id,
                    "epoch": list.epoch,
                }));
            }
        }
    }

    Ok(InboxSweep {
        wraps_seen: wraps.len(),
        accepted,
        skipped,
        promoted,
    })
}

fn rejection_json(wrap_id: &str, rejection: &GrantRejection, channel: Option<&str>) -> Value {
    let mut out = json!({
        "wrapId": wrap_id,
        "reason": rejection.code(),
        "detail": rejection.explain(),
    });
    if let Some(channel) = channel {
        out["channel"] = json!(channel);
    }
    out
}

// ─── read ────────────────────────────────────────────────────────────────────

/// How one channel event renders for this agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// Not sealed at all — a public channel, or a public message.
    Plaintext(String),
    /// Sealed, and opened with a key from the ring.
    Decrypted { content: String, key_id: String },
    /// Sealed under a key this agent does not hold, or a scheme it does not
    /// understand. This is what rotation looks like from the outside.
    Locked { key_id: Option<String> },
}

/// Decide how to render one channel event, given the keys held for it.
///
/// Pure, and that is the point: "rotation locked the agent out" is *observed*
/// here, and it must be provable without a relay or a sidecar in the loop.
/// Mirrors `openChannelEvent`, including its fallback of trying the whole ring
/// when the named key id is not held — a client that reported the wrong key id
/// is still readable if the bytes are there.
pub fn open_message(tags: &[Vec<String>], content: &str, ring: &[ChannelKey]) -> Opened {
    if !is_sealed(tags) {
        return Opened::Plaintext(content.to_string());
    }
    let Some(key_id) = key_id_from_tags(tags) else {
        // Sealed under a scheme this build does not know. Never rendered as
        // plaintext: the bytes would be gibberish that reads like a message.
        return Opened::Locked { key_id: None };
    };
    let key_id = key_id.to_string();

    if let Some(key) = ring.iter().find(|key| channel_key_id(key) == key_id) {
        if let Some(plaintext) = buzz_channel_crypto::open(content, key) {
            return Opened::Decrypted {
                content: plaintext,
                key_id,
            };
        }
    }
    for key in ring {
        if let Some(plaintext) = buzz_channel_crypto::open(content, key) {
            return Opened::Decrypted {
                content: plaintext,
                key_id: channel_key_id(key),
            };
        }
    }
    Opened::Locked {
        key_id: Some(key_id),
    }
}

fn message_json(event: &Event, opened: &Opened) -> Value {
    let mut out = json!({
        "id": event.id.to_hex(),
        "pubkey": event.pubkey.to_hex(),
        "createdAt": event.created_at.as_secs(),
    });
    match opened {
        Opened::Plaintext(content) => {
            out["content"] = json!(content);
            out["encrypted"] = json!(false);
        }
        Opened::Decrypted { content, key_id } => {
            out["content"] = json!(content);
            out["encrypted"] = json!(true);
            out["keyId"] = json!(key_id);
            out["opened"] = json!(true);
        }
        Opened::Locked { key_id } => {
            out["content"] = json!(LOCKED_MESSAGE_PLACEHOLDER);
            out["encrypted"] = json!(true);
            out["keyId"] = json!(key_id);
            out["opened"] = json!(false);
        }
    }
    out
}

async fn cmd_read(
    ctx: &ToonContext<'_>,
    channel: &str,
    limit: u32,
    since: Option<u64>,
) -> Result<(), CliError> {
    validate_uuid(channel)?;
    let keystore = open_keystore(ctx)?;
    let ring = keystore.ring(channel).to_vec();

    let events =
        toon_relay::fetch(ctx.relay_url, channel_message_filter(channel, limit, since)).await?;

    let mut messages = Vec::with_capacity(events.len());
    let mut locked = 0usize;
    for event in &events {
        let tags = tags_as_strings(event);
        let opened = open_message(&tags, &event.content, &ring);
        if matches!(opened, Opened::Locked { .. }) {
            locked += 1;
        }
        messages.push(message_json(event, &opened));
    }

    let mut out = json!({
        "channel": channel,
        "keysHeld": ring.len(),
        "messages": messages,
    });
    if locked > 0 {
        out["hint"] = json!(format!(
            "{locked} of {} message(s) are sealed under a key this agent does not hold — if the \
channel rotated, an admin has to re-add this identity; run `buzz toon inbox` once they have.",
            events.len()
        ));
    }
    print_json(&out)
}

fn cmd_keys(ctx: &ToonContext<'_>) -> Result<(), CliError> {
    let keystore = open_keystore(ctx)?;
    let channels: Vec<Value> = keystore
        .channels()
        .map(|channel| {
            let ring = keystore.ring(channel);
            json!({
                "channel": channel,
                "sendingKeyId": ring.first().map(channel_key_id),
                "keyIds": ring.iter().map(channel_key_id).collect::<Vec<_>>(),
            })
        })
        .collect();
    print_json(&json!({
        "keystore": keystore.path().display().to_string(),
        "channels": channels,
    }))
}

// ─── send ────────────────────────────────────────────────────────────────────

/// What this agent knows about whether a channel is encrypted, from its
/// validated admin list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelEncryption {
    /// A validated admin list names a current key id: the channel is
    /// encrypted, and a plaintext post into it would be a leak.
    Keyed,
    /// A validated admin list exists and names no key: an ordinary public
    /// channel.
    Unkeyed,
    /// No validated admin list was found, or the relay could not be read.
    /// Not the same as "public" — it is "unknown".
    Unknown,
}

/// The plan for one `send`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendPlan {
    /// Seal under the held key and add the marker tag.
    Sealed(ChannelKey),
    /// Post as-is: the channel is not encrypted.
    Plaintext,
    /// Refuse, with the reason to show the caller.
    Refuse(&'static str),
}

/// Decide how — or whether — to post, given what the agent holds and what the
/// channel's admin list says.
///
/// Pure and exhaustively tested, because the invariant it carries is the one
/// with teeth: **plaintext must never be posted into a keyed channel**. Note
/// what "unknown" does — it refuses. Failing open would mean a relay hiccup,
/// or a suppressed admin list, silently downgrades a private channel's message
/// to public; `BUZZ_TOON_ASSUME_PUBLIC` exists so an operator who knows better
/// can say so out loud, and it deliberately cannot override `Keyed`.
pub fn plan_send(
    held_key: Option<ChannelKey>,
    encryption: ChannelEncryption,
    assume_public: bool,
) -> SendPlan {
    match (held_key, encryption) {
        (Some(key), _) => SendPlan::Sealed(key),
        (None, ChannelEncryption::Keyed) => SendPlan::Refuse(
            "not a member — this channel is encrypted and this agent holds no channel key for it. \
An admin has to add this identity (the key arrives as a gift wrap); then run `buzz toon inbox`.",
        ),
        (None, ChannelEncryption::Unkeyed) => SendPlan::Plaintext,
        (None, ChannelEncryption::Unknown) if assume_public => SendPlan::Plaintext,
        (None, ChannelEncryption::Unknown) => SendPlan::Refuse(
            "cannot tell whether this channel is encrypted — no validated admin list was readable \
from the relay, and this agent holds no channel key. Refusing rather than risk posting plaintext \
into a private channel; set BUZZ_TOON_ASSUME_PUBLIC=1 if the channel really is public.",
        ),
    }
}

async fn cmd_send(
    client: &SidecarClient,
    ctx: &ToonContext<'_>,
    channel: &str,
    content: &str,
) -> Result<(), CliError> {
    let content = read_or_stdin(content)?;
    let keystore = open_keystore(ctx)?;
    let outcome = send_message(client, ctx.relay_url, &keystore, channel, content, &[]).await?;

    let mut out =
        serde_json::to_value(&outcome.receipt).map_err(|e| CliError::Other(e.to_string()))?;
    if let Some(obj) = out.as_object_mut() {
        obj.insert("encrypted".to_string(), json!(outcome.encrypted));
    }
    print_json(&out)
}

/// What one [`send_message`] call did, beyond the sidecar's own receipt.
pub struct SendOutcome {
    pub receipt: crate::sidecar::PublishReceipt,
    pub encrypted: bool,
}

/// Seal (if the channel is keyed) and publish one channel message through the
/// sidecar — the exact decision [`plan_send`] makes and `buzz toon send`
/// exercises above.
///
/// Shared by that command and the workflow agent's reply action (buzz#21): a
/// second implementation of "when may this content be posted, and under what
/// key" is precisely the kind of drift that would let an automated actor leak
/// plaintext into a channel a human's `buzz toon send` would have refused.
///
/// `extra_tags` is appended after the channel/encryption tags this function
/// always adds — e.g. the workflow agent's `["client", "buzz-workflow"]`
/// idempotency/provenance marker (the same `["client", ...]` idiom desktop
/// uses, see `desktop/src-tauri/src/events.rs`). Every entry must start with
/// `"client"`, mirroring desktop's `append_client_tags` guard: a caller gets
/// to add a marker, not forge channel or encryption metadata.
pub async fn send_message(
    client: &SidecarClient,
    relay_url: &str,
    keystore: &AgentKeystore,
    channel: &str,
    content: String,
    extra_tags: &[Vec<String>],
) -> Result<SendOutcome, CliError> {
    validate_uuid(channel)?;
    validate_content_size(&content)?;
    if content.trim().is_empty() {
        return Err(CliError::Usage("content must not be empty".into()));
    }
    for tag in extra_tags {
        if tag.first().map(String::as_str) != Some("client") {
            return Err(CliError::Other(format!(
                "extra_tags must use the 'client' prefix (got {:?})",
                tag.first()
            )));
        }
    }

    let held_key = keystore.sending_key(channel);

    // The admin-list read is skipped entirely when a key is held: the answer
    // cannot change the plan, and a free read is still a round trip.
    let encryption = if held_key.is_some() {
        ChannelEncryption::Keyed
    } else {
        match fetch_admin_events(relay_url).await {
            Ok(events) => {
                match resolve_admins(&events, channel, keystore.pinned_creator(channel)) {
                    Some(list) if list.key_id.is_some() => ChannelEncryption::Keyed,
                    // A list with no key, or no list at all: not encrypted.
                    // Only private channels are provisioned with a kind:39100,
                    // so the absence of one is itself the answer, and buzz#15's
                    // public write keeps working exactly as it did.
                    Some(_) | None => ChannelEncryption::Unkeyed,
                }
            }
            // A relay we could not read is "unknown", never "public".
            Err(_) => ChannelEncryption::Unknown,
        }
    };

    let assume_public = std::env::var(ASSUME_PUBLIC_ENV).is_ok_and(|v| !v.is_empty() && v != "0");
    let (content, mut tags, encrypted) = match plan_send(held_key, encryption, assume_public) {
        SendPlan::Refuse(reason) => return Err(CliError::Usage(reason.to_string())),
        SendPlan::Plaintext => (
            content,
            vec![vec!["h".to_string(), channel.to_string()]],
            false,
        ),
        SendPlan::Sealed(key) => (
            seal(&content, &key),
            vec![
                vec!["h".to_string(), channel.to_string()],
                buzz_channel_crypto::encryption_tag(&key).to_vec(),
            ],
            true,
        ),
    };
    tags.extend(extra_tags.iter().cloned());

    let receipt = client
        .publish_unsigned(KIND_CHANNEL_MESSAGE, content, tags)
        .await?;

    Ok(SendOutcome { receipt, encrypted })
}

#[cfg(test)]
mod tests {
    use buzz_channel_crypto::{encryption_tag, FIXED_KEY_ID_VECTOR};

    use super::*;

    const KEY: ChannelKey = [0xdd; 32];
    const ROTATED: ChannelKey = [0x7c; 32];

    fn sealed_tags(key: &ChannelKey) -> Vec<Vec<String>> {
        vec![
            vec!["h".to_string(), "engineering".to_string()],
            encryption_tag(key).to_vec(),
        ]
    }

    #[test]
    fn a_plaintext_message_needs_no_key() {
        let tags = vec![vec!["h".to_string(), "engineering".to_string()]];
        assert_eq!(
            open_message(&tags, "public roadmap", &[]),
            Opened::Plaintext("public roadmap".to_string())
        );
    }

    #[test]
    fn a_held_key_opens_the_message_it_sealed() {
        let payload = seal("rotate the deploy token", &KEY);
        assert_eq!(
            open_message(&sealed_tags(&KEY), &payload, &[KEY]),
            Opened::Decrypted {
                content: "rotate the deploy token".to_string(),
                key_id: FIXED_KEY_ID_VECTOR.to_string(),
            }
        );
    }

    /// buzz#19's third acceptance criterion, observed with no new code: the
    /// removed agent's ring is one epoch behind, so the post-rotation message
    /// simply does not open.
    #[test]
    fn a_ring_without_the_new_epoch_cannot_open_post_rotation_messages() {
        let before = seal("before the removal", &KEY);
        let after = seal("after the removal", &ROTATED);

        // The removed agent still holds only the old key.
        let ring = [KEY];
        assert_eq!(
            open_message(&sealed_tags(&KEY), &before, &ring),
            Opened::Decrypted {
                content: "before the removal".to_string(),
                key_id: FIXED_KEY_ID_VECTOR.to_string(),
            },
            "rotation protects the future, not the past (ADR 0001)"
        );
        assert_eq!(
            open_message(&sealed_tags(&ROTATED), &after, &ring),
            Opened::Locked {
                key_id: Some(channel_key_id(&ROTATED)),
            },
        );

        // A member who did receive the new wrap keeps both and reads both.
        let member_ring = [ROTATED, KEY];
        assert!(matches!(
            open_message(&sealed_tags(&ROTATED), &after, &member_ring),
            Opened::Decrypted { .. }
        ));
        assert!(matches!(
            open_message(&sealed_tags(&KEY), &before, &member_ring),
            Opened::Decrypted { .. }
        ));
    }

    #[test]
    fn a_scheme_this_build_cannot_open_is_locked_not_rendered() {
        let tags = vec![
            vec!["h".to_string(), "engineering".to_string()],
            vec![
                "encrypted".to_string(),
                "nip44-v3-from-the-future".to_string(),
                "deadbeefdeadbeef".to_string(),
            ],
        ];
        assert_eq!(
            open_message(&tags, "AAAA", &[KEY]),
            Opened::Locked { key_id: None }
        );
    }

    #[test]
    fn a_mislabelled_key_id_still_opens_from_the_ring() {
        let payload = seal("the id in the tag is wrong", &KEY);
        let tags = vec![
            vec!["h".to_string(), "engineering".to_string()],
            vec![
                "encrypted".to_string(),
                "nip44-v2".to_string(),
                "0000000000000000".to_string(),
            ],
        ];
        assert!(matches!(
            open_message(&tags, &payload, &[ROTATED, KEY]),
            Opened::Decrypted { .. }
        ));
    }

    #[test]
    fn holding_a_key_always_means_sealing() {
        assert_eq!(
            plan_send(Some(KEY), ChannelEncryption::Keyed, false),
            SendPlan::Sealed(KEY)
        );
        // Even if the channel's admin list looks unkeyed: the agent was given
        // a key for it, and the plaintext post would be the surprising one.
        assert_eq!(
            plan_send(Some(KEY), ChannelEncryption::Unkeyed, false),
            SendPlan::Sealed(KEY)
        );
    }

    /// The invariant with teeth: never post plaintext into a keyed channel.
    #[test]
    fn a_keyed_channel_with_no_key_is_refused_not_posted_in_the_clear() {
        let SendPlan::Refuse(reason) = plan_send(None, ChannelEncryption::Keyed, false) else {
            panic!("posting plaintext into a keyed channel must be refused");
        };
        assert!(reason.contains("not a member"));
        assert!(reason.contains("channel key"));

        // The escape hatch must not open a hole in this: the admin list is
        // evidence, not a guess.
        assert!(matches!(
            plan_send(None, ChannelEncryption::Keyed, true),
            SendPlan::Refuse(_)
        ));
    }

    /// buzz#15's public-channel write must keep working untouched. A public
    /// channel has no admin list at all — only private ones are provisioned
    /// with a kind:39100 — which resolves to `Unkeyed`, not `Unknown`.
    #[test]
    fn a_public_channel_still_posts_in_the_clear() {
        assert_eq!(
            plan_send(None, ChannelEncryption::Unkeyed, false),
            SendPlan::Plaintext
        );
    }

    /// Only an unreadable relay is "unknown" — and then the write waits
    /// rather than guessing.
    #[test]
    fn an_unreadable_relay_fails_closed_unless_told_otherwise() {
        assert!(matches!(
            plan_send(None, ChannelEncryption::Unknown, false),
            SendPlan::Refuse(_)
        ));
        assert_eq!(
            plan_send(None, ChannelEncryption::Unknown, true),
            SendPlan::Plaintext
        );
    }

    #[test]
    fn a_sealed_send_carries_the_marker_tag_and_hides_the_plaintext() {
        let SendPlan::Sealed(key) = plan_send(Some(KEY), ChannelEncryption::Keyed, false) else {
            panic!("expected a sealed plan");
        };
        let payload = seal("secret roadmap update", &key);
        let marker = encryption_tag(&key);

        assert!(!payload.contains("secret roadmap"));
        assert_eq!(marker[0], "encrypted");
        assert_eq!(marker[1], "nip44-v2");
        assert_eq!(marker[2], FIXED_KEY_ID_VECTOR);
        // A desktop client reading this event resolves the same key id.
        assert_eq!(
            open_message(&sealed_tags(&key), &payload, &[KEY]),
            Opened::Decrypted {
                content: "secret roadmap update".to_string(),
                key_id: FIXED_KEY_ID_VECTOR.to_string(),
            }
        );
    }
}
