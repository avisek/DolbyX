//! The plugin's state machine — everything the FFI entry delegates to,
//! raw-pointer-free: host lifecycle in, [`DaemonLink`] calls out.

use crate::client::DaemonLink;
use crate::pcm;

/// The rate assumed for a host that resumes without ever calling
/// `effSetSampleRate` — v1's assumption, the desktop default.
const DEFAULT_SAMPLE_RATE: u32 = 48_000;

/// One plugin instance's state. No DSP, no persistence — all control
/// lives in the Web UI (issue #21); this only ferries audio.
#[derive(Debug)]
pub struct Effect {
    link: DaemonLink,
    sample_rate: u32,
    /// The host block, copied at `stage` so `render` can (a) pass it
    /// through bit-exact when dry and (b) tolerate in-place hosts.
    staged_left: Vec<f32>,
    staged_right: Vec<f32>,
    /// Interleaved PCM16 scratch — the wire form, reused per block.
    pcm_in: Vec<i16>,
    pcm_out: Vec<i16>,
}

impl Effect {
    /// A fresh, unconnected instance.
    pub fn new() -> Self {
        Self {
            link: DaemonLink::new(),
            sample_rate: DEFAULT_SAMPLE_RATE,
            staged_left: Vec::new(),
            staged_right: Vec::new(),
            pcm_in: Vec::new(),
            pcm_out: Vec::new(),
        }
    }

    /// `effSetSampleRate`. Sessions are rate-immutable (epic #8): a
    /// change while connected is `Goodbye` + fresh `Hello`, right here.
    #[expect(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "guarded finite ≥ 1 rate; fractional rates don't exist in practice"
    )]
    pub fn set_sample_rate(&mut self, rate: f32) {
        if !rate.is_finite() || rate < 1.0 {
            return;
        }
        let rate = rate as u32;
        let changed = rate != self.sample_rate;
        self.sample_rate = rate;
        if changed && self.link.is_connected() {
            self.link.connect(rate);
        }
    }

    /// `effMainsChanged(1)`: connect eagerly so the first block is wet.
    pub fn resume(&mut self) {
        self.link.connect(self.sample_rate);
    }

    /// `effMainsChanged(0)`: `Goodbye` — sessions exist only while
    /// audio can flow (epic #8).
    pub fn suspend(&mut self) {
        self.link.disconnect();
    }

    /// `effClose`.
    pub fn close(&mut self) {
        self.link.disconnect();
    }

    /// First half of `processReplacing`: copies the host's input away.
    /// Kept separate from [`Self::render`] so the entry's input
    /// borrows end before its output borrows begin — in-place hosts
    /// (EqualizerAPO's shape) alias input and output memory.
    pub fn stage(&mut self, left: &[f32], right: &[f32]) {
        debug_assert_eq!(left.len(), right.len(), "stereo halves match");
        self.staged_left.clear();
        self.staged_left.extend_from_slice(left);
        self.staged_right.clear();
        self.staged_right.extend_from_slice(right);
    }

    /// Second half of `processReplacing`: ferries the staged block
    /// through the daemon — or passes it through bit-exact (dry) while
    /// the daemon is away, reconnecting periodically. Audio never
    /// stops (issue #21).
    pub fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        debug_assert_eq!(left.len(), self.staged_left.len(), "render mirrors stage");
        debug_assert_eq!(right.len(), self.staged_right.len(), "render mirrors stage");
        self.link.ensure(self.sample_rate);
        if self.link.is_connected() {
            pcm::interleave_to_i16(&self.staged_left, &self.staged_right, &mut self.pcm_in);
            if self.link.ferry(&self.pcm_in, &mut self.pcm_out) {
                pcm::deinterleave_to_f32(&self.pcm_out, left, right);
                return;
            }
        }
        // Dry: the daemon is away (or was just lost mid-block).
        left.copy_from_slice(&self.staged_left);
        right.copy_from_slice(&self.staged_right);
    }
}
