//! Float32 ↔ int16 PCM conversion — once, at the host boundary
//! (epic #8: audio stays int16 stereo from here to `libdseffect.so`).
//!
//! The asymmetric PCM16 convention: full scale is 32768, so every i16
//! survives the round trip exactly (`-32768` = −1.0) and +1.0
//! saturates at 32767. Conversion rounds half away from zero — zero
//! maps to zero and symmetric inputs stay symmetric (no DC offset).

/// Full-scale factor: i16 ⇄ f32 map through 32768.
const SCALE: f32 = 32768.0;

/// One host sample → PCM16: scale, round, saturate (NaN → 0).
#[must_use]
#[expect(
    clippy::cast_possible_truncation,
    reason = "float→int `as` saturates — exactly the clip behavior PCM16 needs"
)]
pub fn to_i16(sample: f32) -> i16 {
    (sample * SCALE).round() as i16
}

/// One PCM16 sample → host float in `[-1.0, 32767∕32768]`.
#[must_use]
pub fn to_f32(sample: i16) -> f32 {
    f32::from(sample) / SCALE
}

/// Converts one stereo block into interleaved PCM16, replacing `pcm`'s
/// contents. `left`/`right` must be the same length.
pub fn interleave_to_i16(left: &[f32], right: &[f32], pcm: &mut Vec<i16>) {
    debug_assert_eq!(left.len(), right.len(), "stereo halves match");
    pcm.clear();
    pcm.reserve(left.len() * 2);
    for (l, r) in left.iter().zip(right) {
        pcm.push(to_i16(*l));
        pcm.push(to_i16(*r));
    }
}

/// Writes one interleaved PCM16 block back as stereo host floats.
/// `pcm` must hold exactly `left.len() == right.len()` frames.
pub fn deinterleave_to_f32(pcm: &[i16], left: &mut [f32], right: &mut [f32]) {
    debug_assert_eq!(left.len(), right.len(), "stereo halves match");
    debug_assert_eq!(pcm.len(), left.len() * 2, "one stereo pair per frame");
    for (frame, (l, r)) in pcm.chunks_exact(2).zip(left.iter_mut().zip(right)) {
        *l = to_f32(frame[0]);
        *r = to_f32(frame[1]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Behavior 1 (issue #21): the i16 → f32 → i16 round trip is the
    /// identity for every value — including the ±32767/−32768 edges.
    #[test]
    fn every_i16_survives_the_float_round_trip() {
        for sample in i16::MIN..=i16::MAX {
            assert_eq!(to_i16(to_f32(sample)), sample, "{sample}");
        }
    }

    /// Behavior 1: clipping saturates — over-full-scale input pins at
    /// the rails instead of wrapping; NaN falls to silence.
    #[test]
    fn out_of_range_floats_saturate() {
        assert_eq!(to_i16(1.0), i16::MAX, "+1.0 is one step past +full");
        assert_eq!(to_i16(-1.0), i16::MIN);
        assert_eq!(to_i16(2.5), i16::MAX);
        assert_eq!(to_i16(-2.5), i16::MIN);
        assert_eq!(to_i16(f32::INFINITY), i16::MAX);
        assert_eq!(to_i16(f32::NEG_INFINITY), i16::MIN);
        assert_eq!(to_i16(f32::NAN), 0);
    }

    /// Behavior 1: no DC offset — zero maps to zero both ways, and a
    /// signal and its negation convert to sample-wise negations
    /// (truncation toward zero or floor-rounding would bias).
    #[test]
    #[expect(clippy::float_cmp, reason = "0 ⇄ 0.0 is exact by spec")]
    fn conversion_is_symmetric_around_zero() {
        assert_eq!(to_i16(0.0), 0);
        assert_eq!(to_f32(0), 0.0);
        for sample in [0.1_f32, 0.25, 1.0 / 3.0, 0.5, 0.9, 0.999] {
            assert_eq!(to_i16(-sample), -to_i16(sample), "{sample}");
        }
    }

    proptest::proptest! {
        /// The quantization error of convert-and-back stays within one
        /// PCM16 step over the whole in-range axis — an independent
        /// bound (the worst case is saturation at +1.0: exactly 1∕32768).
        #[test]
        fn round_trip_error_stays_within_one_step(sample in -1.0_f32..=1.0) {
            let error = (to_f32(to_i16(sample)) - sample).abs();
            proptest::prop_assert!(error <= 1.0 / 32768.0, "error {error}");
        }
    }

    #[test]
    #[expect(
        clippy::float_cmp,
        reason = "i16∕32768 quotients are exact in f32 — equality is the spec"
    )]
    fn interleave_and_deinterleave_mirror_each_other() {
        let left = [0.0_f32, 0.5, -0.5, 1.0];
        let right = [-1.0_f32, 0.25, -0.25, 0.0];
        let mut pcm = vec![99; 2]; // stale contents must be replaced
        interleave_to_i16(&left, &right, &mut pcm);
        assert_eq!(pcm, [0, -32768, 16384, 8192, -16384, -8192, 32767, 0]);

        let (mut l, mut r) = ([0.0_f32; 4], [0.0_f32; 4]);
        deinterleave_to_f32(&pcm, &mut l, &mut r);
        assert_eq!(l, [0.0, 0.5, -0.5, 32767.0 / 32768.0]);
        assert_eq!(r, [-1.0, 0.25, -0.25, 0.0]);
    }
}
