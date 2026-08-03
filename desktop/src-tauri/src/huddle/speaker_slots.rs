//! Pubkey → playout-slot mapping for the TOON huddle receive path (buzz#23).
//!
//! The legacy audio room hands every peer a relay-assigned `peer_index` that
//! the playout loop uses as a stable NetEq stream identity. On TOON there is
//! no room and no relay-side roster — frames arrive attributed only by the
//! sender's pubkey — so the receive pipeline allocates its own local indices
//! here. Indices are only ever meaningful inside this process (a synthetic
//! SSRC for NetEq plus a map key for the per-speaker rodio player); two
//! listeners in the same huddle may number the same speakers differently.

use std::collections::HashMap;

/// Highest slot index handed out (inclusive). Matches the legacy room's
/// `peer_index` domain (`u8`, 255 reserved as invalid) — far above the
/// measured concurrent-speaker envelope (N≤3 guaranteed, N≤10 opportunistic).
const MAX_SLOT: u8 = 254;

/// Allocates and recycles per-speaker slots.
#[derive(Default)]
pub struct SpeakerSlots {
    by_pubkey: HashMap<String, u8>,
}

impl SpeakerSlots {
    pub fn new() -> Self {
        Self::default()
    }

    /// The slot for `pubkey`, allocating the lowest free index on first
    /// sight. `None` only when all 255 slots are taken — the caller drops
    /// the frame rather than evicting an active speaker.
    pub fn slot_for(&mut self, pubkey: &str) -> Option<u8> {
        if let Some(&slot) = self.by_pubkey.get(pubkey) {
            return Some(slot);
        }
        let taken: std::collections::HashSet<u8> = self.by_pubkey.values().copied().collect();
        let free = (0..=MAX_SLOT).find(|candidate| !taken.contains(candidate))?;
        self.by_pubkey.insert(pubkey.to_string(), free);
        Some(free)
    }

    /// Forget `pubkey`, freeing its slot for reuse. Returns the freed slot
    /// so the caller can drop the matching jitter buffer / player.
    pub fn release(&mut self, pubkey: &str) -> Option<u8> {
        self.by_pubkey.remove(pubkey)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_pubkey_keeps_the_same_slot() {
        let mut slots = SpeakerSlots::new();
        let a = slots.slot_for("alice").unwrap();
        assert_eq!(slots.slot_for("alice").unwrap(), a);
        let b = slots.slot_for("bob").unwrap();
        assert_ne!(a, b);
        assert_eq!(slots.slot_for("alice").unwrap(), a);
    }

    #[test]
    fn released_slots_are_reused_lowest_first() {
        let mut slots = SpeakerSlots::new();
        let a = slots.slot_for("alice").unwrap();
        let _b = slots.slot_for("bob").unwrap();
        assert_eq!(slots.release("alice"), Some(a));
        // A new speaker takes the freed lowest index.
        assert_eq!(slots.slot_for("carol").unwrap(), a);
    }

    #[test]
    fn releasing_an_unknown_pubkey_is_a_no_op() {
        let mut slots = SpeakerSlots::new();
        assert_eq!(slots.release("nobody"), None);
    }

    #[test]
    fn allocation_fails_only_when_every_slot_is_taken() {
        let mut slots = SpeakerSlots::new();
        for i in 0..=u32::from(MAX_SLOT) {
            assert!(slots.slot_for(&format!("speaker-{i}")).is_some());
        }
        assert_eq!(slots.slot_for("one-too-many"), None);
        // Existing speakers are unaffected.
        assert!(slots.slot_for("speaker-0").is_some());
    }
}
