//! Speech gate for the TOON huddle publish path (buzz#23).
//!
//! On TOON every published frame is a paid write, so silence must publish —
//! and pay — nothing. This is a deliberately simple energy gate over the
//! per-frame dBov level the encode loop already computes
//! ([`super::wire::audio_level_dbov`]): a frame at or above the speech
//! threshold opens the gate, and the gate then stays open for a trailing
//! hangover of a few hundred milliseconds so word endings and short
//! intra-phrase pauses don't clip. No comfort noise is generated for the
//! gated-off span; the listener's NetEq treats the gap as ordinary silence.
//!
//! The legacy relay-room transport keeps its Opus-DTX behaviour and does not
//! use this gate — DTX comfort packets cost nothing over a plain WebSocket.

/// Frames at or above this level count as speech. Typical normalized speech
/// peaks measure ≈ -20..-8 dBov (see `wire.rs`'s tests); ambient room noise
/// through a normal mic sits below ≈ -55 dBov. -50 keeps quiet speech in
/// while leaving fan/keyboard noise out.
pub const SPEECH_THRESHOLD_DBOV: i8 = -50;

/// How many consecutive sub-threshold frames keep publishing after the last
/// speech frame. 20 frames × 20 ms = 400 ms — "a few hundred ms" of trailing
/// hangover, enough to carry word endings and breath tails.
pub const HANGOVER_FRAMES: u16 = 20;

/// Energy gate with trailing hangover. One instance per publishing session;
/// feed it every encoded frame's level in order and publish only when
/// [`SpeechGate::should_publish`] says so.
pub struct SpeechGate {
    threshold_dbov: i8,
    hangover_frames: u16,
    /// Sub-threshold frames still allowed through before the gate closes.
    /// `None` until the first speech frame — the gate starts closed, so a
    /// join into a silent room publishes nothing at all.
    remaining: Option<u16>,
}

impl Default for SpeechGate {
    fn default() -> Self {
        Self::new(SPEECH_THRESHOLD_DBOV, HANGOVER_FRAMES)
    }
}

impl SpeechGate {
    pub fn new(threshold_dbov: i8, hangover_frames: u16) -> Self {
        Self {
            threshold_dbov,
            hangover_frames,
            remaining: None,
        }
    }

    /// Whether the frame whose level is `level_dbov` should be published.
    /// Call exactly once per 20 ms frame, in capture order.
    pub fn should_publish(&mut self, level_dbov: i8) -> bool {
        if level_dbov >= self.threshold_dbov {
            self.remaining = Some(self.hangover_frames);
            return true;
        }
        match self.remaining {
            None | Some(0) => {
                self.remaining = Some(0);
                false
            }
            Some(n) => {
                self.remaining = Some(n - 1);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEECH: i8 = -20;
    const SILENCE: i8 = -70;

    #[test]
    fn gate_starts_closed_so_silence_publishes_nothing() {
        let mut gate = SpeechGate::default();
        for _ in 0..500 {
            assert!(!gate.should_publish(SILENCE));
        }
    }

    #[test]
    fn speech_opens_the_gate_immediately() {
        let mut gate = SpeechGate::default();
        assert!(!gate.should_publish(SILENCE));
        assert!(
            gate.should_publish(SPEECH),
            "first speech frame must publish"
        );
    }

    #[test]
    fn hangover_carries_exactly_the_configured_trailing_frames() {
        let mut gate = SpeechGate::new(SPEECH_THRESHOLD_DBOV, 3);
        assert!(gate.should_publish(SPEECH));
        // Word ending: 3 trailing sub-threshold frames still publish...
        assert!(gate.should_publish(SILENCE));
        assert!(gate.should_publish(SILENCE));
        assert!(gate.should_publish(SILENCE));
        // ...then the gate closes and stays closed.
        assert!(!gate.should_publish(SILENCE));
        assert!(!gate.should_publish(SILENCE));
    }

    #[test]
    fn speech_during_hangover_rearms_the_full_hangover() {
        let mut gate = SpeechGate::new(SPEECH_THRESHOLD_DBOV, 2);
        assert!(gate.should_publish(SPEECH));
        assert!(gate.should_publish(SILENCE)); // 1 of 2 spent
        assert!(gate.should_publish(SPEECH)); // re-trigger
        assert!(gate.should_publish(SILENCE)); // full hangover again: 1 of 2
        assert!(gate.should_publish(SILENCE)); // 2 of 2
        assert!(!gate.should_publish(SILENCE));
    }

    #[test]
    fn a_level_exactly_at_threshold_counts_as_speech() {
        let mut gate = SpeechGate::default();
        assert!(gate.should_publish(SPEECH_THRESHOLD_DBOV));
    }

    #[test]
    fn default_hangover_is_a_few_hundred_ms_of_20ms_frames() {
        // 20 ms per frame — the wire cadence this gate is calibrated against.
        let ms = u32::from(HANGOVER_FRAMES) * 20;
        assert!(
            (200..=600).contains(&ms),
            "hangover should be a few hundred ms, got {ms} ms",
        );
    }

    #[test]
    fn gate_reopens_after_closing_when_speech_resumes() {
        let mut gate = SpeechGate::new(SPEECH_THRESHOLD_DBOV, 1);
        assert!(gate.should_publish(SPEECH));
        assert!(gate.should_publish(SILENCE));
        assert!(!gate.should_publish(SILENCE));
        assert!(gate.should_publish(SPEECH));
    }
}
