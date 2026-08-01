//! Turning an unwrapped NIP-59 rumor into a channel key the agent will
//! actually use — or a named refusal (buzz#19).
//!
//! A Rust port of the recipient half of
//! `desktop/src/shared/api/channelKeyDelivery.ts` (`unwrapChannelKey`'s
//! post-decryption validation, plus `acceptChannelKeyGrant`). The decryption
//! itself belongs to the sidecar, which holds the agent's secret key; what is
//! left here is every check that decides whether the plaintext is *trusted*,
//! and none of it needs a secret.
//!
//! The wire layering, for reference:
//!
//! ```text
//! kind:1059 wrap    signed by an ephemeral key    ["p", recipient]
//!   kind:13 seal    signed by the REAL sender     no tags
//!     kind:44300 rumor  unsigned, id only         ["h", channelId], ["key", keyId, epoch]
//!                       content = 64 hex chars — the raw channel key
//! ```
//!
//! The relay is public and enforces nothing (ADR 0001), so a wrap proves only
//! that *somebody* sent the agent a key. Three things make it trustworthy:
//! the seal's signature (the sidecar reports its pubkey), that pubkey being an
//! admin on the channel's **validated** kind:39100 list, and the epoch not
//! going backwards.

use buzz_channel_crypto::{channel_key_id, parse_channel_key, ChannelKey};
use serde_json::Value;

use crate::channel_admins::ChannelAdminList;

/// `kind:44300` — the channel-key delivery rumor. Matches
/// `desktop/src/shared/constants/kinds.ts`'s `KIND_CHANNEL_KEY_DELIVERY`.
pub const CHANNEL_KEY_RUMOR_KIND: u64 = 44300;

/// `kind:1059` — the NIP-59 gift wrap.
pub const GIFT_WRAP_KIND: u64 = 1059;

/// A structurally valid key delivery, before the authority check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelKeyGrant {
    pub channel_id: String,
    pub key: ChannelKey,
    /// Always recomputed from the bytes, never the tag's claim.
    pub key_id: String,
    pub epoch: u64,
    /// The kind:13 seal's signer — the real author of the delivery.
    pub sender: String,
}

/// Why a rumor is not a usable channel key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantRejection {
    /// Not a kind:44300 rumor — some other gift-wrapped payload (a DM, say).
    NotAKeyDelivery,
    /// The rumor claims an author other than the seal's signer: NIP-59 says
    /// the seal's signer is the author, so this is a relayed forgery attempt.
    AuthorMismatch,
    /// No `["h", <channelId>]` tag.
    NoChannel,
    /// The content is not 32 bytes of hex.
    MalformedKey,
    /// The `["key", <keyId>, …]` tag names a key id the bytes do not hash to.
    KeyIdMismatch,
    /// This build has no validated admin list for the channel, so there is
    /// nothing to check the sender against. Fail closed.
    NoAdminList,
    /// The seal's signer is not an admin on the validated list.
    SenderNotAdmin,
    /// The grant is for an epoch the channel has already moved past — a
    /// replayed pre-rotation wrap.
    StaleEpoch,
}

impl GrantRejection {
    /// A stable machine-readable name, so `buzz toon inbox --json` output can
    /// be asserted on and grepped rather than parsed out of prose.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotAKeyDelivery => "not-a-key-delivery",
            Self::AuthorMismatch => "author-mismatch",
            Self::NoChannel => "no-channel",
            Self::MalformedKey => "malformed-key",
            Self::KeyIdMismatch => "key-id-mismatch",
            Self::NoAdminList => "no-admin-list",
            Self::SenderNotAdmin => "sender-not-admin",
            Self::StaleEpoch => "stale-epoch",
        }
    }

    pub fn explain(&self) -> &'static str {
        match self {
            Self::NotAKeyDelivery => "the wrap held something other than a channel-key delivery",
            Self::AuthorMismatch => {
                "the rumor names an author other than the seal's signer — a forwarded forgery"
            }
            Self::NoChannel => "the delivery names no channel",
            Self::MalformedKey => "the delivery's key is not 32 bytes of hex",
            Self::KeyIdMismatch => "the declared key id does not match the key bytes",
            Self::NoAdminList => {
                "no validated admin list for this channel — nothing to check the sender against"
            }
            Self::SenderNotAdmin => "the sender is not an admin of this channel",
            Self::StaleEpoch => "the key is for an epoch the channel has already rotated past",
        }
    }
}

fn tag_value<'a>(tags: &'a [Vec<String>], name: &str) -> Option<&'a str> {
    tags.iter().find_map(|tag| {
        let matches = tag.first()?.as_str() == name;
        let value = tag.get(1)?.as_str();
        (matches && !value.is_empty()).then_some(value)
    })
}

fn tag_at<'a>(tags: &'a [Vec<String>], name: &str, index: usize) -> Option<&'a str> {
    tags.iter().find_map(|tag| {
        (tag.first()?.as_str() == name).then(|| tag.get(index).map(String::as_str))?
    })
}

/// Pull the string tag rows out of an unsigned rumor's JSON.
fn rumor_tags(rumor: &Value) -> Vec<Vec<String>> {
    rumor
        .get("tags")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(
                        row.as_array()?
                            .iter()
                            .filter_map(|cell| cell.as_str().map(str::to_string))
                            .collect(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Read a channel key out of an unwrapped rumor, with `seal_pubkey` as the
/// authenticated author. Structure only — [`accept_grant`] decides authority.
pub fn parse_key_rumor(
    rumor: &Value,
    seal_pubkey: &str,
) -> Result<ChannelKeyGrant, GrantRejection> {
    if rumor.get("kind").and_then(Value::as_u64) != Some(CHANNEL_KEY_RUMOR_KIND) {
        return Err(GrantRejection::NotAKeyDelivery);
    }
    let seal_pubkey = seal_pubkey.trim().to_ascii_lowercase();
    // NIP-59: the seal's signer is the author. A rumor claiming a different
    // one has been lifted out of somebody else's seal and re-wrapped.
    if let Some(claimed) = rumor.get("pubkey").and_then(Value::as_str) {
        if claimed.trim().to_ascii_lowercase() != seal_pubkey {
            return Err(GrantRejection::AuthorMismatch);
        }
    }

    let tags = rumor_tags(rumor);
    let channel_id = tag_value(&tags, "h")
        .ok_or(GrantRejection::NoChannel)?
        .to_string();
    let key = rumor
        .get("content")
        .and_then(Value::as_str)
        .and_then(parse_channel_key)
        .ok_or(GrantRejection::MalformedKey)?;

    let key_id = channel_key_id(&key);
    if let Some(declared) = tag_value(&tags, "key") {
        if declared != key_id {
            return Err(GrantRejection::KeyIdMismatch);
        }
    }
    // A missing or unparseable epoch collapses to 0, matching the TS side.
    let epoch = tag_at(&tags, "key", 2)
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(0);

    Ok(ChannelKeyGrant {
        channel_id,
        key,
        key_id,
        epoch,
        sender: seal_pubkey,
    })
}

/// The authority check: is this grant from someone entitled to hand out this
/// channel's key, and is it not a replay? Mirrors `acceptChannelKeyGrant`.
///
/// This is the whole of the "no agent-specific backdoor" property — an agent
/// is admitted by exactly the rule a human client applies to itself, with no
/// branch anywhere that asks whether the recipient is an agent.
pub fn accept_grant(
    grant: &ChannelKeyGrant,
    admin_list: Option<&ChannelAdminList>,
) -> Result<(), GrantRejection> {
    let Some(list) = admin_list else {
        return Err(GrantRejection::NoAdminList);
    };
    if !list.is_admin(&grant.sender) {
        return Err(GrantRejection::SenderNotAdmin);
    }
    if grant.epoch < list.epoch {
        return Err(GrantRejection::StaleEpoch);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    use serde_json::json;

    use crate::channel_admins::{resolve_channel_admin_list, CHANNEL_ADMIN_LIST_KIND};

    use super::*;

    const CHANNEL: &str = "3b0f-private-channel";
    const KEY: ChannelKey = [0xdd; 32];

    fn key_hex() -> String {
        hex::encode(KEY)
    }

    /// The rumor shape `buildChannelKeyRumor` produces, as JSON — the content
    /// is the bare hex key, not a JSON envelope.
    fn rumor(sender: &str, epoch: u64) -> Value {
        json!({
            "kind": CHANNEL_KEY_RUMOR_KIND,
            "pubkey": sender,
            "created_at": 1_700_000_000,
            "content": key_hex(),
            "tags": [
                ["h", CHANNEL],
                ["key", channel_key_id(&KEY), epoch.to_string()],
                ["p", "f".repeat(64)],
            ],
        })
    }

    fn admin_list(signer: &Keys, admins: &[&str], epoch: u64) -> ChannelAdminList {
        let mut tags = vec![
            Tag::parse(["d", CHANNEL]).unwrap(),
            Tag::parse(["creator", &signer.public_key().to_hex()]).unwrap(),
        ];
        for admin in admins {
            tags.push(Tag::parse(["p", admin, "admin"]).unwrap());
        }
        tags.push(Tag::parse(["key", &channel_key_id(&KEY), &epoch.to_string()]).unwrap());
        let event = EventBuilder::new(Kind::Custom(CHANNEL_ADMIN_LIST_KIND), "")
            .tags(tags)
            // The creator p-tags themselves; `nostr` strips self-tags unless
            // told not to.
            .allow_self_tagging()
            .custom_created_at(Timestamp::from_secs(1_700_000_000))
            .sign_with_keys(signer)
            .unwrap();
        resolve_channel_admin_list(&[event], CHANNEL, None).unwrap()
    }

    #[test]
    fn a_well_formed_delivery_from_an_admin_is_accepted() {
        let admin = Keys::generate();
        let sender = admin.public_key().to_hex();
        let list = admin_list(&admin, &[&sender], 0);

        let grant = parse_key_rumor(&rumor(&sender, 0), &sender).unwrap();
        assert_eq!(grant.channel_id, CHANNEL);
        assert_eq!(grant.key, KEY);
        assert_eq!(grant.key_id, channel_key_id(&KEY));
        assert_eq!(grant.sender, sender);
        assert!(accept_grant(&grant, Some(&list)).is_ok());
    }

    /// The acceptance criterion in prose: an agent is admitted by the standard
    /// flow, and nothing in that flow asks whether the recipient is an agent.
    #[test]
    fn an_agent_recipient_takes_exactly_the_same_path_as_a_human() {
        let admin = Keys::generate();
        let sender = admin.public_key().to_hex();
        let list = admin_list(&admin, &[&sender], 0);

        // The only thing that differs between a human member and an agent
        // member is the `["p", recipient]` tag, which this side never reads.
        let human = parse_key_rumor(&rumor(&sender, 0), &sender).unwrap();
        let mut agent_rumor = rumor(&sender, 0);
        agent_rumor["tags"][2][1] = json!("a".repeat(64));
        let agent = parse_key_rumor(&agent_rumor, &sender).unwrap();

        assert_eq!(human.key, agent.key);
        assert_eq!(
            accept_grant(&human, Some(&list)),
            accept_grant(&agent, Some(&list))
        );
    }

    #[test]
    fn a_grant_from_a_non_admin_is_refused() {
        let admin = Keys::generate();
        let stranger = Keys::generate().public_key().to_hex();
        let list = admin_list(&admin, &[&admin.public_key().to_hex()], 0);

        let grant = parse_key_rumor(&rumor(&stranger, 0), &stranger).unwrap();
        assert_eq!(
            accept_grant(&grant, Some(&list)),
            Err(GrantRejection::SenderNotAdmin)
        );
    }

    #[test]
    fn without_an_admin_list_nothing_is_accepted() {
        let sender = Keys::generate().public_key().to_hex();
        let grant = parse_key_rumor(&rumor(&sender, 0), &sender).unwrap();
        assert_eq!(accept_grant(&grant, None), Err(GrantRejection::NoAdminList));
    }

    #[test]
    fn a_pre_rotation_epoch_is_refused_as_stale() {
        let admin = Keys::generate();
        let sender = admin.public_key().to_hex();
        let list = admin_list(&admin, &[&sender], 3);

        let grant = parse_key_rumor(&rumor(&sender, 1), &sender).unwrap();
        assert_eq!(
            accept_grant(&grant, Some(&list)),
            Err(GrantRejection::StaleEpoch)
        );
        // The current epoch, and anything ahead of it, is fine: a key can be
        // delivered before the list naming it lands.
        let current = parse_key_rumor(&rumor(&sender, 3), &sender).unwrap();
        assert!(accept_grant(&current, Some(&list)).is_ok());
        let ahead = parse_key_rumor(&rumor(&sender, 4), &sender).unwrap();
        assert!(accept_grant(&ahead, Some(&list)).is_ok());
    }

    #[test]
    fn a_rumor_claiming_another_author_is_a_forgery() {
        let real = Keys::generate().public_key().to_hex();
        let forwarder = Keys::generate().public_key().to_hex();
        assert_eq!(
            parse_key_rumor(&rumor(&real, 0), &forwarder),
            Err(GrantRejection::AuthorMismatch)
        );
    }

    #[test]
    fn a_declared_key_id_that_does_not_match_the_bytes_is_refused() {
        let sender = Keys::generate().public_key().to_hex();
        let mut forged = rumor(&sender, 0);
        forged["tags"][1][1] = json!("ffffffffffffffff");
        assert_eq!(
            parse_key_rumor(&forged, &sender),
            Err(GrantRejection::KeyIdMismatch)
        );
    }

    #[test]
    fn a_non_key_rumor_is_not_a_delivery() {
        let sender = Keys::generate().public_key().to_hex();
        let mut dm = rumor(&sender, 0);
        dm["kind"] = json!(14);
        assert_eq!(
            parse_key_rumor(&dm, &sender),
            Err(GrantRejection::NotAKeyDelivery)
        );
    }

    #[test]
    fn a_malformed_key_or_missing_channel_is_refused() {
        let sender = Keys::generate().public_key().to_hex();

        let mut short = rumor(&sender, 0);
        short["content"] = json!("dead");
        short["tags"] = json!([["h", CHANNEL]]);
        assert_eq!(
            parse_key_rumor(&short, &sender),
            Err(GrantRejection::MalformedKey)
        );

        let mut unrouted = rumor(&sender, 0);
        unrouted["tags"] = json!([["key", channel_key_id(&KEY), "0"]]);
        assert_eq!(
            parse_key_rumor(&unrouted, &sender),
            Err(GrantRejection::NoChannel)
        );
    }

    #[test]
    fn an_epochless_delivery_reads_as_epoch_zero() {
        let sender = Keys::generate().public_key().to_hex();
        let mut plain = rumor(&sender, 0);
        plain["tags"] = json!([["h", CHANNEL], ["key", channel_key_id(&KEY)]]);
        assert_eq!(parse_key_rumor(&plain, &sender).unwrap().epoch, 0);
    }

    #[test]
    fn rejection_codes_are_stable_and_distinct() {
        let all = [
            GrantRejection::NotAKeyDelivery,
            GrantRejection::AuthorMismatch,
            GrantRejection::NoChannel,
            GrantRejection::MalformedKey,
            GrantRejection::KeyIdMismatch,
            GrantRejection::NoAdminList,
            GrantRejection::SenderNotAdmin,
            GrantRejection::StaleEpoch,
        ];
        let mut codes: Vec<&str> = all.iter().map(GrantRejection::code).collect();
        codes.sort_unstable();
        let count = codes.len();
        codes.dedup();
        assert_eq!(codes.len(), count);
        assert!(all.iter().all(|r| !r.explain().is_empty()));
    }
}
