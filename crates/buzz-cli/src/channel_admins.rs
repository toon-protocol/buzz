//! kind:39100 channel admin lists — the membership authority an agent-member
//! checks before it trusts a channel key (buzz#19).
//!
//! A Rust port of `desktop/src/shared/api/channelAdminList.ts`
//! (`parseChannelAdminListEvent` + `resolveChannelAdminList`), deliberately
//! minimal: this side only ever *reads* a list, so the builder, the per-signer
//! retention store, and the TOFU creator pin stay in TS.
//!
//! ## Why an agent needs this at all
//!
//! ADR 0001 moved membership off the relay: the relay serves everyone, so a
//! gift-wrapped channel key proves only that *somebody* sent it. Without this
//! fold an agent would adopt a key from any stranger who wrapped one to it,
//! and then happily seal its replies under a key an attacker also holds. The
//! authority is a signature chain rooted in the channel's creator, and the
//! rules below are the whole of it:
//!
//! 1. **Signature-verified candidates only** — `Event::verify()` (id and
//!    schnorr signature) before a list event is even considered.
//! 2. **Time-ordered replay** — oldest `created_at` first, ties broken by
//!    ascending event id, and the whole set folded from scratch. Not
//!    incremental: an event arriving late still lands in its own place.
//! 3. **Genesis is a self-naming creator** — the first candidate whose
//!    `creator` tag names its own signer roots the chain (and must match the
//!    caller's pinned creator, when one is supplied).
//! 4. **Successors need standing** — a later event is accepted only if it
//!    names the same creator AND its signer was an admin in the *preceding*
//!    state (never in its own tags — that is the forgery a self-declared
//!    admin list would be).
//! 5. **The epoch never regresses** — a candidate carrying an older epoch is
//!    refused, which is what stops a replayed pre-rotation list from
//!    un-rotating a channel.
//!
//! A candidate failing any check is skipped, never fatal: one bad event must
//! not poison the good ones after it.

use std::cmp::Ordering;

use nostr::Event;

/// `kind:39100` — the replaceable channel admin list. Matches
/// `desktop/src/shared/constants/kinds.ts`'s `KIND_CHANNEL_ADMIN_LIST`.
pub const CHANNEL_ADMIN_LIST_KIND: u16 = 39100;

/// Roles on a `["p", <pubkey>, <role>]` tag that count as admin. Matches
/// `channelAdminList.ts`'s `ADMIN_ROLES`; the TS builder only ever writes
/// `"admin"`, but `"owner"` is accepted for the same reason it is there.
const ADMIN_ROLES: [&str; 2] = ["admin", "owner"];

/// One structurally-valid kind:39100 event, before the chain is folded.
#[derive(Debug, Clone)]
struct AdminListEvent {
    channel_id: String,
    creator: String,
    admins: Vec<String>,
    key_id: Option<String>,
    epoch: u64,
    signer: String,
    created_at: u64,
    event_id: String,
}

/// The resolved state of a channel's admin chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelAdminList {
    pub channel_id: String,
    /// The pubkey the chain is rooted in. Everything else derives from it.
    pub creator: String,
    /// Admins in canonical order: creator first, then first-seen order.
    pub admins: Vec<String>,
    /// The key id the channel currently sends under, when the list names one.
    pub key_id: Option<String>,
    /// The current key epoch. Monotonic across the chain.
    pub epoch: u64,
    /// `created_at` of the event that produced this state.
    pub updated_at: u64,
}

impl ChannelAdminList {
    /// Whether `pubkey` may distribute this channel's key or trigger a
    /// rotation. Mirrors `isChannelAdmin`.
    pub fn is_admin(&self, pubkey: &str) -> bool {
        match normalize_pubkey(pubkey) {
            Some(candidate) => self.admins.contains(&candidate),
            None => false,
        }
    }
}

/// Lowercase a pubkey and require exactly 64 hex chars, like
/// `channelAdminList.ts`'s `normalizePubkey`. Anything else is not a pubkey
/// and is dropped rather than passed along to be compared as a string.
fn normalize_pubkey(value: &str) -> Option<String> {
    let trimmed = value.trim().to_ascii_lowercase();
    (trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit())).then_some(trimmed)
}

/// First tag named `name` whose value slot is non-empty. Matches
/// `firstTagValue` — an empty value is treated as absent, not as `""`.
fn first_tag_value<'a>(tags: &'a [Vec<String>], name: &str) -> Option<&'a str> {
    tags.iter().find_map(|tag| {
        let found = tag.first()?.as_str() == name;
        let value = tag.get(1)?.as_str();
        (found && !value.is_empty()).then_some(value)
    })
}

/// Creator first, then each further admin in the order given, deduplicated.
/// Matches `canonicalAdmins`.
fn canonical_admins(creator: &str, admins: &[String]) -> Vec<String> {
    let mut ordered = vec![creator.to_string()];
    for candidate in admins {
        if let Some(pubkey) = normalize_pubkey(candidate) {
            if !ordered.contains(&pubkey) {
                ordered.push(pubkey);
            }
        }
    }
    ordered
}

/// Structural parse of one event, with no trust decisions. `None` for
/// anything that is not a well-formed admin list — including a list that
/// omits its own creator, which is a contradiction (the chain is rooted in
/// them) rather than a demotion.
fn parse_admin_list_event(event: &Event, tags: &[Vec<String>]) -> Option<AdminListEvent> {
    if event.kind.as_u16() != CHANNEL_ADMIN_LIST_KIND {
        return None;
    }

    let channel_id = first_tag_value(tags, "d")?.to_string();
    let creator = normalize_pubkey(first_tag_value(tags, "creator")?)?;
    let signer = normalize_pubkey(&event.pubkey.to_hex())?;

    let mut admins: Vec<String> = Vec::new();
    for tag in tags {
        if tag.first().map(String::as_str) != Some("p") {
            continue;
        }
        let role = tag.get(2).map(String::as_str).unwrap_or("");
        if !ADMIN_ROLES.contains(&role) {
            continue;
        }
        if let Some(pubkey) = tag.get(1).and_then(|p| normalize_pubkey(p)) {
            if !admins.contains(&pubkey) {
                admins.push(pubkey);
            }
        }
    }
    if !admins.contains(&creator) {
        return None;
    }

    let key_tag = tags.iter().find(|tag| {
        tag.first().map(String::as_str) == Some("key")
            && tag.get(1).is_some_and(|value| !value.is_empty())
    });
    // A missing, negative, or unparseable epoch collapses to 0, exactly as
    // `Number.parseInt(... ?? "0")` guarded by `>= 0` does in TS.
    let epoch = key_tag
        .and_then(|tag| tag.get(2))
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(0);

    Some(AdminListEvent {
        channel_id,
        admins: canonical_admins(&creator, &admins),
        creator,
        key_id: key_tag.and_then(|tag| tag.get(1)).cloned(),
        epoch,
        signer,
        created_at: event.created_at.as_secs(),
        event_id: event.id.to_hex(),
    })
}

/// Deterministic order: oldest first, event id breaking `created_at` ties.
/// Matches `chainOrder`.
fn chain_order(left: &AdminListEvent, right: &AdminListEvent) -> Ordering {
    left.created_at
        .cmp(&right.created_at)
        .then_with(|| left.event_id.cmp(&right.event_id))
}

fn to_state(candidate: &AdminListEvent) -> ChannelAdminList {
    ChannelAdminList {
        channel_id: candidate.channel_id.clone(),
        creator: candidate.creator.clone(),
        admins: candidate.admins.clone(),
        key_id: candidate.key_id.clone(),
        epoch: candidate.epoch,
        updated_at: candidate.created_at,
    }
}

/// Fold every kind:39100 event for `channel_id` into the channel's current
/// admin state, or `None` when no valid chain roots.
///
/// `expected_creator` is the caller's pinned root. `None` means trust-on-first
/// -use: the earliest self-naming event wins, which is backdate-vulnerable for
/// a channel this process has never seen before — the same caveat
/// `resolveChannelAdminList` documents. An agent that already knows whose
/// channel it is should always pass it.
pub fn resolve_channel_admin_list(
    events: &[Event],
    channel_id: &str,
    expected_creator: Option<&str>,
) -> Option<ChannelAdminList> {
    let expected_creator = expected_creator.and_then(normalize_pubkey);

    let mut candidates: Vec<AdminListEvent> = events
        .iter()
        .filter_map(|event| {
            let tags = tags_as_strings(event);
            let parsed = parse_admin_list_event(event, &tags)?;
            if parsed.channel_id != channel_id {
                return None;
            }
            // Signature check last of the cheap filters, first of the trust
            // decisions: `pubkey` means nothing until the event verifies.
            event.verify().ok()?;
            Some(parsed)
        })
        .collect();
    candidates.sort_by(chain_order);

    let mut state: Option<ChannelAdminList> = None;
    for candidate in &candidates {
        let Some(current) = state.as_ref() else {
            let roots_itself = candidate.creator == candidate.signer;
            let is_expected = expected_creator
                .as_ref()
                .is_none_or(|expected| &candidate.signer == expected);
            if roots_itself && is_expected {
                state = Some(to_state(candidate));
            }
            continue;
        };

        if candidate.creator != current.creator {
            continue;
        }
        if !current.admins.contains(&candidate.signer) {
            continue;
        }
        if candidate.epoch < current.epoch {
            continue;
        }
        state = Some(to_state(candidate));
    }

    state
}

/// A NIP-01 subscription filter for admin lists.
///
/// Deliberately not scoped by `#d`: an agent must be able to validate a key
/// wrapped for a channel whose id it does not know yet, which is exactly the
/// first-admission case. Matches `channelAdminListFilter`.
pub fn channel_admin_list_filter(limit: u32) -> serde_json::Value {
    serde_json::json!({ "kinds": [CHANNEL_ADMIN_LIST_KIND], "limit": limit })
}

/// `nostr::Tags` as plain string vectors, the shape the TS port reads.
pub fn tags_as_strings(event: &Event) -> Vec<Vec<String>> {
    event
        .tags
        .iter()
        .map(|tag| tag.clone().to_vec())
        .collect::<Vec<_>>()
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};

    use super::*;

    const CHANNEL: &str = "9f2c1d54-channel";

    /// Build and sign a kind:39100 list the way `buildChannelAdminListEvent`
    /// does, so these tests exercise the real wire shape rather than a
    /// hand-rolled one.
    fn admin_list(
        signer: &Keys,
        creator: &str,
        admins: &[&str],
        key_id: Option<(&str, u64)>,
        created_at: u64,
    ) -> Event {
        let mut tags = vec![
            Tag::parse(["d", CHANNEL]).unwrap(),
            Tag::parse(["creator", creator]).unwrap(),
        ];
        for admin in admins {
            tags.push(Tag::parse(["p", admin, "admin"]).unwrap());
        }
        if let Some((id, epoch)) = key_id {
            tags.push(Tag::parse(["key", id, &epoch.to_string()]).unwrap());
        }
        EventBuilder::new(Kind::Custom(CHANNEL_ADMIN_LIST_KIND), "")
            .tags(tags)
            // A channel's creator is always an admin of their own channel, so
            // the list p-tags its own author — and `nostr`'s builder strips
            // self-tags unless told not to.
            .allow_self_tagging()
            .custom_created_at(Timestamp::from_secs(created_at))
            .sign_with_keys(signer)
            .unwrap()
    }

    fn hex(keys: &Keys) -> String {
        keys.public_key().to_hex()
    }

    #[test]
    fn genesis_is_a_creator_naming_itself() {
        let creator = Keys::generate();
        let list = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            Some(("aaaaaaaaaaaaaaaa", 0)),
            1_700_000_000,
        );
        let resolved = resolve_channel_admin_list(&[list], CHANNEL, None).unwrap();
        assert_eq!(resolved.creator, hex(&creator));
        assert_eq!(resolved.admins, vec![hex(&creator)]);
        assert_eq!(resolved.key_id.as_deref(), Some("aaaaaaaaaaaaaaaa"));
        assert_eq!(resolved.epoch, 0);
    }

    #[test]
    fn a_list_naming_someone_else_as_creator_cannot_root_the_chain() {
        let impostor = Keys::generate();
        let victim = Keys::generate();
        let forged = admin_list(
            &impostor,
            &hex(&victim),
            &[&hex(&victim), &hex(&impostor)],
            None,
            1_699_000_000,
        );
        assert!(resolve_channel_admin_list(&[forged], CHANNEL, None).is_none());
    }

    #[test]
    fn a_pinned_creator_refuses_a_different_root() {
        let real = Keys::generate();
        let other = Keys::generate();
        let squatter = admin_list(
            &other,
            &hex(&other),
            &[&hex(&other)],
            None,
            1_699_000_000, // backdated ahead of the real genesis
        );
        let genuine = admin_list(&real, &hex(&real), &[&hex(&real)], None, 1_700_000_000);
        let resolved =
            resolve_channel_admin_list(&[squatter, genuine], CHANNEL, Some(&hex(&real))).unwrap();
        assert_eq!(resolved.creator, hex(&real));
    }

    #[test]
    fn an_admin_added_by_the_creator_can_publish_the_next_list() {
        let creator = Keys::generate();
        let admin = Keys::generate();
        let member = Keys::generate();

        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator), &hex(&admin)],
            Some(("aaaaaaaaaaaaaaaa", 0)),
            1_700_000_000,
        );
        let by_admin = admin_list(
            &admin,
            &hex(&creator),
            &[&hex(&creator), &hex(&admin), &hex(&member)],
            Some(("bbbbbbbbbbbbbbbb", 1)),
            1_700_000_500,
        );

        let resolved = resolve_channel_admin_list(&[genesis, by_admin], CHANNEL, None).unwrap();
        assert_eq!(resolved.admins.len(), 3);
        assert!(resolved.is_admin(&hex(&member)));
        assert_eq!(resolved.epoch, 1);
    }

    #[test]
    fn a_stranger_cannot_write_themselves_into_the_list() {
        let creator = Keys::generate();
        let stranger = Keys::generate();

        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            None,
            1_700_000_000,
        );
        // Signed by someone who was not an admin in the preceding state, but
        // who names themselves an admin in their own tags.
        let grab = admin_list(
            &stranger,
            &hex(&creator),
            &[&hex(&creator), &hex(&stranger)],
            None,
            1_700_000_500,
        );

        let resolved = resolve_channel_admin_list(&[genesis, grab], CHANNEL, None).unwrap();
        assert!(!resolved.is_admin(&hex(&stranger)));
        assert_eq!(resolved.admins, vec![hex(&creator)]);
    }

    #[test]
    fn a_demoted_admins_later_events_stop_being_accepted() {
        let creator = Keys::generate();
        let demoted = Keys::generate();
        let outsider = Keys::generate();

        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator), &hex(&demoted)],
            None,
            1_700_000_000,
        );
        let demotion = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            None,
            1_700_000_600,
        );
        let revenge = admin_list(
            &demoted,
            &hex(&creator),
            &[&hex(&creator), &hex(&demoted), &hex(&outsider)],
            None,
            1_700_000_700,
        );

        let resolved =
            resolve_channel_admin_list(&[genesis, demotion, revenge], CHANNEL, None).unwrap();
        assert!(!resolved.is_admin(&hex(&demoted)));
        assert!(!resolved.is_admin(&hex(&outsider)));
    }

    #[test]
    fn the_key_epoch_never_moves_backwards() {
        let creator = Keys::generate();
        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            Some(("aaaaaaaaaaaaaaaa", 0)),
            1_700_000_000,
        );
        let rotation = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            Some(("cccccccccccccccc", 1)),
            1_700_000_600,
        );
        // A replay of the pre-rotation list, re-published later.
        let replay = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            Some(("aaaaaaaaaaaaaaaa", 0)),
            1_700_000_900,
        );

        let resolved =
            resolve_channel_admin_list(&[genesis, rotation, replay], CHANNEL, None).unwrap();
        assert_eq!(resolved.epoch, 1);
        assert_eq!(resolved.key_id.as_deref(), Some("cccccccccccccccc"));
    }

    #[test]
    fn a_tampered_event_is_dropped_before_the_fold() {
        let creator = Keys::generate();
        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            None,
            1_700_000_000,
        );
        // Re-signing is impossible without the key, so flip the content: the
        // id no longer matches the serialization and `verify()` fails.
        let mut json = serde_json::to_value(&genesis).unwrap();
        json["content"] = serde_json::Value::String("tampered".to_string());
        let tampered: Event = serde_json::from_value(json).unwrap();

        assert!(resolve_channel_admin_list(&[tampered], CHANNEL, None).is_none());
    }

    #[test]
    fn a_list_that_drops_its_own_creator_is_ignored() {
        let creator = Keys::generate();
        let other = Keys::generate();
        let contradiction = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&other)],
            None,
            1_700_000_000,
        );
        assert!(resolve_channel_admin_list(&[contradiction], CHANNEL, None).is_none());
    }

    #[test]
    fn events_for_another_channel_are_not_folded_in() {
        let creator = Keys::generate();
        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            None,
            1_700_000_000,
        );
        assert!(resolve_channel_admin_list(&[genesis], "some-other-channel", None).is_none());
    }

    #[test]
    fn out_of_order_delivery_folds_to_the_same_state() {
        let creator = Keys::generate();
        let admin = Keys::generate();
        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator), &hex(&admin)],
            Some(("aaaaaaaaaaaaaaaa", 0)),
            1_700_000_000,
        );
        let later = admin_list(
            &admin,
            &hex(&creator),
            &[&hex(&creator), &hex(&admin)],
            Some(("bbbbbbbbbbbbbbbb", 2)),
            1_700_000_500,
        );

        let forward =
            resolve_channel_admin_list(&[genesis.clone(), later.clone()], CHANNEL, None).unwrap();
        let reversed = resolve_channel_admin_list(&[later, genesis], CHANNEL, None).unwrap();
        assert_eq!(forward, reversed);
        assert_eq!(forward.epoch, 2);
    }

    #[test]
    fn is_admin_is_case_insensitive_and_rejects_non_pubkeys() {
        let creator = Keys::generate();
        let genesis = admin_list(
            &creator,
            &hex(&creator),
            &[&hex(&creator)],
            None,
            1_700_000_000,
        );
        let resolved = resolve_channel_admin_list(&[genesis], CHANNEL, None).unwrap();
        assert!(resolved.is_admin(&hex(&creator).to_uppercase()));
        assert!(!resolved.is_admin("not-a-pubkey"));
        assert!(!resolved.is_admin(""));
    }
}
