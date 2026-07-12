//! Engine-native i16 ↔ display-unit conversion, driven by `frac_bits`.
//!
//! Only the UI converts on the live path (epic invariant) — this module
//! is the property-gated reference twin of `ui/src/lib/units.ts`: same
//! scaling (`display = raw / 2^frac_bits`), same rounding (half away
//! from zero), same saturation, kept in lockstep by mirrored suites
//! (`proptest` here, Vitest there).

/// The display value of an engine-native `raw`: `raw / 2^frac_bits`
/// (`frac_bits = 4` ⇒ 1/16-dB coding). Exact for every i16 — dividing
/// by a power of two loses no f64 bits.
#[must_use]
pub fn raw_to_display(raw: i16, frac_bits: u8) -> f64 {
    f64::from(raw) / scale(frac_bits)
}

/// The engine-native value of a display `value`:
/// `round(value × 2^frac_bits)` half away from zero, saturated to the
/// i16 domain (NaN ⇒ 0).
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    reason = "f64 → i16 `as` saturates and zeroes NaN — the exact contract"
)]
pub fn display_to_raw(value: f64, frac_bits: u8) -> i16 {
    (value * scale(frac_bits)).round() as i16
}

/// `2^frac_bits`, exact in f64 over the whole u8 domain.
fn scale(frac_bits: u8) -> f64 {
    2_f64.powi(i32::from(frac_bits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    /// The docs' scaling cheat-sheet landmarks
    /// (`docs/ddp/02-ak-parameters.md`): ±6 dB ↔ ±96, −130 dB ↔ −2080;
    /// `frac_bits = 0` is the identity.
    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "power-of-two scaling of i16 is exact — `==` is the spec"
    )]
    fn converts_the_documented_landmarks() {
        assert_eq!(raw_to_display(96, 4), 6.0);
        assert_eq!(raw_to_display(-2080, 4), -130.0);
        assert_eq!(display_to_raw(3.0, 4), 48);
        assert_eq!(display_to_raw(-6.0, 4), -96);
        assert_eq!(raw_to_display(7, 0), 7.0);
        assert_eq!(display_to_raw(7.0, 0), 7);
    }

    #[test]
    fn rounds_half_away_from_zero_saturates_and_zeroes_nan() {
        assert_eq!(display_to_raw(0.031_25, 4), 1, "half a step rounds up");
        assert_eq!(display_to_raw(-0.031_25, 4), -1, "…and down below zero");
        assert_eq!(display_to_raw(5000.0, 4), i16::MAX);
        assert_eq!(display_to_raw(-5000.0, 4), i16::MIN);
        assert_eq!(display_to_raw(f64::NAN, 4), 0);
    }

    proptest! {
        /// Behavior 8 (issue #22), invertibility half: every i16
        /// round-trips exactly through display units — the UI can
        /// rehydrate any wire value without drift.
        #[test]
        fn every_i16_round_trips_exactly(raw: i16, frac_bits in 0_u8..=8) {
            prop_assert_eq!(
                display_to_raw(raw_to_display(raw, frac_bits), frac_bits),
                raw,
            );
        }

        /// Behavior 8, clamp half: clamping in display units then
        /// converting equals converting then clamping to the
        /// `ParameterDef` `[min, max]` — a display-side slider bound
        /// and the daemon's engine-unit validation agree.
        #[test]
        fn display_clamp_agrees_with_engine_clamp(
            value in -40_000_f64..=40_000_f64,
            frac_bits in 0_u8..=8,
            a: i16,
            b: i16,
        ) {
            let (min, max) = (a.min(b), a.max(b));
            let display_clamped = value.clamp(
                raw_to_display(min, frac_bits),
                raw_to_display(max, frac_bits),
            );
            prop_assert_eq!(
                display_to_raw(display_clamped, frac_bits),
                display_to_raw(value, frac_bits).clamp(min, max),
            );
        }

        /// Behavior 8, quantization half: display → raw → display moves
        /// a value at most half a quantization step.
        #[test]
        fn display_round_trip_stays_within_half_a_step(
            value in -127_f64..=127_f64,
            frac_bits in 0_u8..=8,
        ) {
            let step = raw_to_display(1, frac_bits);
            let round_tripped =
                raw_to_display(display_to_raw(value, frac_bits), frac_bits);
            prop_assert!((round_tripped - value).abs() <= step / 2.0);
        }
    }
}
