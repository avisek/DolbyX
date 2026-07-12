//! `session_id` → live session: one shared engine process multiplexes
//! every session (epic #8). Ids are minted here, monotonically, never
//! reused within a shim's lifetime. Each session pairs its effect
//! handle with the AK-direct param surface (ADR-0010) — registries are
//! per-handle, so refs and writes never cross sessions.

use std::collections::HashMap;

use ddp_engine::protocol::{ParamName, STATUS_INVALID, STATUS_NO_SESSION};

use crate::ffi::{Effect, EngineLib};

/// The rates `Effect_reinit` honours. Anything else *silently falls
/// back to 44100 while replying success* (`setconfig_probe` Sc5), so
/// the shim rejects up front — the engine never sees a bad rate.
const SUPPORTED_RATES: [u32; 3] = [44_100, 48_000, 32_000];

/// Structural-param groups → commit leaf. The engine only *stages* a
/// band-count / centre-frequency write; the filterbank re-derives when
/// the group's commit leaf (its last payload array) is rewritten —
/// even unchanged (**touch = commit**, `reshape_probe`). Shim-internal
/// engine-binding knowledge, versioned with the binary — never in
/// `ParameterDef`, never above the `Engine` trait (ADR-0010).
const COMMIT_GROUPS: [(&[ParamName], ParamName); 4] = [
    (&[*b"genb", *b"gebf"], *b"gebg"),
    (&[*b"ienb", *b"iebf"], *b"iebt"),
    (&[*b"aonb", *b"aocc", *b"aobf"], *b"aobg"),
    (&[*b"arnb", *b"arbf"], *b"arbh"),
];

/// The vis tail's four ReadOnly-Dynamic arrays, in reply order.
const VIS_TAIL_NAMES: [ParamName; 4] = [*b"vnbg", *b"vnbe", *b"vcbg", *b"vcbe"];

/// Slots per vis array — fixed 20 at every rate (at 32 kHz only
/// `vnnb` = 19 are live; the 20th is engine-stale), keeping the tail
/// a fixed 4 × 20 i16 = 160 bytes.
const VIS_BAND_SLOTS: usize = 20;

/// One live session: the effect handle plus its cached AK refs.
pub struct Session<'lib> {
    effect: Effect<'lib>,
    /// `ak_find` results, cached per handle — refs are tagged tree
    /// paths, fixed for the session's life (rate never changes after
    /// init). `0` = dead ref (unknown 4-CC), cached too.
    refs: HashMap<ParamName, u32>,
    /// [`VIS_TAIL_NAMES`]' refs, resolved once — `process` reads them
    /// every block.
    vis_refs: [u32; 4],
}

impl<'lib> Session<'lib> {
    fn new(effect: Effect<'lib>) -> Self {
        let vis_refs = VIS_TAIL_NAMES.map(|name| effect.param_ref(name));
        Self {
            effect,
            refs: HashMap::new(),
            vis_refs,
        }
    }

    /// The 4-CC's AK ref, resolved once per session via `ak_find`.
    fn param_ref(&mut self, name: ParamName) -> u32 {
        let effect = &self.effect;
        *self
            .refs
            .entry(name)
            .or_insert_with(|| effect.param_ref(name))
    }

    /// Writes one atomic batch into the live registry, in order. Every
    /// entry lands before the next `process` block, so the batch
    /// applies on one audio block (the DSP recomputes from the
    /// registry per block). Never fails: unknown 4-CCs are dead refs
    /// the accessors drop, clamping and write-protection are the
    /// engine's own silent semantics, and the daemon validated values
    /// up front — mirroring the engine, a bad entry is a silent no-op.
    pub fn set_params(&mut self, params: &[(ParamName, Vec<i16>)]) {
        for (name, values) in params {
            let param_ref = self.param_ref(*name);
            if param_ref == 0 {
                continue;
            }
            // Cap at the leaf's fixed capacity: `ak_set_bulk` has no
            // protocol-side size check, so the shim keeps an oversized
            // count from running past the engine's storage.
            let capacity = usize::try_from(self.effect.param_length(param_ref)).unwrap_or(0);
            let count = values.len().min(capacity);
            self.effect.write_param(param_ref, &values[..count]);
        }
        for (stagers, leaf) in COMMIT_GROUPS {
            let staged = params.iter().any(|(name, _)| stagers.contains(name));
            let committed = params.iter().any(|(name, _)| *name == leaf);
            if staged && !committed {
                self.touch(leaf);
            }
        }
    }

    /// Re-writes `leaf` with its current value — **touch = commit**:
    /// the write itself makes the engine re-derive the group's
    /// filterbank at the next block. A local read → write round-trip;
    /// the daemon never sees it. Storage is fixed-capacity (40), so a
    /// count change never re-aligns arrays — this commit is all a
    /// reshape needs (`reshape_probe` D).
    fn touch(&mut self, leaf: ParamName) {
        let param_ref = self.param_ref(leaf);
        if param_ref == 0 {
            return;
        }
        let length = usize::try_from(self.effect.param_length(param_ref)).unwrap_or(0);
        let current = self.effect.read_param(param_ref, length);
        self.effect.write_param(param_ref, &current);
    }

    /// Reads the live **clamped** registry values for `names`, in
    /// order — count per name = the leaf's engine length. Unknown
    /// 4-CCs read as empty.
    pub fn get_params(&mut self, names: &[ParamName]) -> Vec<Vec<i16>> {
        names
            .iter()
            .map(|&name| {
                let param_ref = self.param_ref(name);
                if param_ref == 0 {
                    return Vec::new();
                }
                let length = usize::try_from(self.effect.param_length(param_ref)).unwrap_or(0);
                self.effect.read_param(param_ref, length)
            })
            .collect()
    }

    /// `EFFECT_CMD_ENABLE` / `EFFECT_CMD_DISABLE` (see [`Effect`]).
    ///
    /// # Errors
    ///
    /// The engine's negative status.
    pub fn set_enabled(&mut self, enabled: bool) -> Result<(), i32> {
        self.effect.set_enabled(enabled)
    }

    /// Processes one interleaved-stereo block (see [`Effect`]).
    pub fn process(&mut self, input: &mut [i16], output: &mut [i16]) -> i32 {
        self.effect.process(input, output)
    }

    /// The block's vis tail — `vnbg ‖ vnbe ‖ vcbg ‖ vcbe`, 4 × 20 i16,
    /// read locally from the registry the DSP just wrote. Rides every
    /// `Process` reply, bypassed blocks included (vis is
    /// process-driven, not power-gated).
    pub fn vis_tail(&self) -> Vec<i16> {
        let mut tail = Vec::with_capacity(VIS_TAIL_NAMES.len() * VIS_BAND_SLOTS);
        for param_ref in self.vis_refs {
            tail.extend(self.effect.read_param(param_ref, VIS_BAND_SLOTS));
        }
        tail
    }
}

/// The live sessions, keyed by shim-minted id.
pub struct SessionTable<'lib> {
    lib: &'lib EngineLib,
    next_id: u32,
    sessions: HashMap<u32, Session<'lib>>,
}

impl<'lib> SessionTable<'lib> {
    /// An empty table minting ids from 1.
    pub fn new(lib: &'lib EngineLib) -> Self {
        Self {
            lib,
            next_id: 1,
            sessions: HashMap::new(),
        }
    }

    /// Creates a session: effect handle → `EFFECT_CMD_INIT` → one
    /// `EFFECT_CMD_SET_CONFIG` at `sample_rate` (stereo + PCM16 +
    /// WRITE pinned). No `DEFINE_PARAMS` / `DEFINE_SETTINGS` handshake
    /// — ever (ADR-0010). The session starts disabled, as the engine
    /// leaves it.
    ///
    /// # Errors
    ///
    /// [`STATUS_INVALID`] for an unsupported rate; otherwise the
    /// engine's own status. A half-initialised handle is released
    /// before returning.
    pub fn create(&mut self, sample_rate: u32) -> Result<u32, i32> {
        if !SUPPORTED_RATES.contains(&sample_rate) {
            return Err(STATUS_INVALID);
        }
        let id = self.next_id;
        let android_session = i32::try_from(id).map_err(|_| STATUS_INVALID)?;
        let mut effect = self.lib.create_effect(android_session)?;
        effect.init()?; // Err drops `effect` → handle released
        effect.set_config(sample_rate)?;
        self.next_id += 1;
        self.sessions.insert(id, Session::new(effect));
        Ok(id)
    }

    /// Releases a session's handle.
    ///
    /// # Errors
    ///
    /// [`STATUS_NO_SESSION`] when `id` names no live session.
    pub fn destroy(&mut self, id: u32) -> Result<(), i32> {
        self.sessions
            .remove(&id)
            .map(drop) // Effect::drop releases the handle
            .ok_or(STATUS_NO_SESSION)
    }

    /// The session, for params, enable/disable, and process.
    ///
    /// # Errors
    ///
    /// [`STATUS_NO_SESSION`] when `id` names no live session.
    pub fn get_mut(&mut self, id: u32) -> Result<&mut Session<'lib>, i32> {
        self.sessions.get_mut(&id).ok_or(STATUS_NO_SESSION)
    }
}
