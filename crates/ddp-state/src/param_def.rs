//! The `ParameterDef` table — the single source of truth for AK parameter
//! metadata, parsed from a runtime `parameters.toml`.
//!
//! Everything downstream — wire validation, engine init, persistence, UI
//! generation, ranges — derives from this table
//! ([ADR-0004](https://github.com/avisek/DolbyX/blob/main/docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).
//! The table is curated and validation-clean — every `default` slot in
//! `[min, max]`; CI checks its structure against the committed
//! `parameters.engine.toml` twin: names 1:1, lengths equal, ranges
//! within the engine envelope.

use serde::{Deserialize, Serialize};

/// Metadata for one AK parameter (one root leaf of the engine's AK tree).
/// (`Serialize` feeds the UI bootstrap; the wire shape mirrors the TOML.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ParameterDef {
    /// 4-CC name: `"dvla"`, `"iebt"`, … (1–4 lowercase ASCII alphanumerics).
    pub name: String,
    /// Engine `ak_get_length` — the fixed allocation; the effective count
    /// for band arrays is the group's `*nb` value at runtime.
    pub length: usize,
    /// Inclusive lower bound, in engine units.
    pub min: i16,
    /// Inclusive upper bound, in engine units.
    pub max: i16,
    /// Fixed-point scale: display = raw / 2^`frac_bits` (4 ⇒ 1/16 dB).
    pub frac_bits: u8,
    /// `length`-sized base value, every slot in `[min, max]` (power-on
    /// truth lives in the param twin).
    pub default: Vec<i16>,
    /// Drives UI widget choice + unit label.
    pub kind: ParamKind,
    /// UI grouping.
    pub category: ParamCategory,
    /// Settability bucket.
    pub access: ParamAccess,
    /// Human-readable display name.
    pub label: String,
    /// Engine one-liner.
    pub description: String,
    /// Engine long help — may be empty (absent in TOML ⇒ empty).
    #[serde(default)]
    pub help: String,
}

/// What a parameter *is* for the UI — widget choice + unit label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum ParamKind {
    /// 0/1 switch.
    Toggle,
    /// 0/1/2 switch, where "on" = 1 or 2 (2 = the engine's auto mode).
    Tristate {
        /// The value the UI writes for "on" (1 or 2).
        on: i16,
    },
    /// Plain integer.
    Integer,
    /// dB-coded value (raw / 2^`frac_bits` dB).
    Decibel {
        /// `true` switches the unit label dB → LKFS (`dvli`/`dvlo`).
        lkfs: bool,
    },
    /// Frequency in Hz.
    FrequencyHz,
    /// Angle in degrees.
    Degrees,
    /// Unit-less per-band array.
    PerBand,
    /// `aobg` — channel-id-prefixed band-gain layout.
    AobgChannelMajor,
    /// License blobs etc. — render as `int[]`.
    Opaque,
}

/// Settability bucket — DSP semantics + UI presentation, not engine
/// acceptance (the engine forwards a SET against any declared param).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamAccess {
    /// Well-defined DSP behavior; editable widgets (Java's whitelist).
    Settable,
    /// Real DSP input the original DDP UI hid; editable behind a badge.
    Experimental,
    /// Write-protected, rewritten by the DSP every audio block.
    ReadOnlyDynamic,
    /// Read once per session after `SET_CONFIG`; surfaced as `readouts`.
    ReadOnlyStatic,
}

impl ParamAccess {
    /// Whether a profile owns the param — the Settable + Experimental
    /// buckets (the 52 non-readonly params).
    #[must_use]
    pub const fn is_writable(self) -> bool {
        matches!(self, Self::Settable | Self::Experimental)
    }
}

/// The complete writable-param map at `ParameterDef.default` — the
/// cascade's base layer, seeding every profile before the overlay
/// layers apply (ADR-0007).
#[must_use]
pub fn base_params(defs: &[ParameterDef]) -> std::collections::HashMap<String, Vec<i16>> {
    defs.iter()
        .filter(|def| def.access.is_writable())
        .map(|def| (def.name.clone(), def.default.clone()))
        .collect()
}

/// UI grouping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParamCategory {
    /// Intelligent EQ.
    Ieq,
    /// Graphic EQ.
    Geq,
    /// Volume Leveller (Dolby Volume).
    VolumeLeveller,
    /// Dialog Enhancer.
    DialogEnhancer,
    /// Headphone virtualizer (Dolby Headphone).
    HeadphoneVirtualizer,
    /// Speaker virtualizer (Dolby Virtual Speaker).
    SpeakerVirtualizer,
    /// Next Gen Surround (upmixer).
    NextGenSurround,
    /// Audio Regulator (multi-band compressor / limiter).
    AudioRegulator,
    /// Audio Optimizer (per-device EQ).
    AudioOptimizer,
    /// Volume maximizer.
    VolumeMaximizer,
    /// Peak limiter.
    PeakLimiter,
    /// Visualizer bands (native + custom families).
    Visualizer,
    /// Endpoint, host volume, and output config slots.
    EndpointVolume,
    /// Engine identity + license slots (`bver bndl ver lcmf lcvd lcpt`).
    BuildLicense,
}

/// Why a `parameters.toml` document was rejected.
#[derive(Debug, thiserror::Error)]
pub enum ParseError {
    /// Not valid TOML for the schema (syntax, missing field, unknown
    /// field/enum, out-of-range integer). Carries the TOML span.
    #[error(transparent)]
    Toml(#[from] toml::de::Error),
    /// Two `[[param]]` entries share a 4-CC name.
    #[error("duplicate parameter `{0}`")]
    DuplicateName(String),
    /// `default` does not carry exactly `length` values.
    #[error("parameter `{name}`: default has {actual} values, `length` says {expected}")]
    DefaultLengthMismatch {
        /// The offending parameter.
        name: String,
        /// Its declared `length`.
        expected: usize,
        /// How many values `default` actually carries.
        actual: usize,
    },
    /// `min` exceeds `max`.
    #[error("parameter `{name}`: min {min} > max {max}")]
    InvertedBounds {
        /// The offending parameter.
        name: String,
        /// Its declared lower bound.
        min: i16,
        /// Its declared upper bound.
        max: i16,
    },
    /// `name` is not a 4-CC: 1–4 lowercase ASCII alphanumerics.
    #[error("parameter name {0:?} is not a 4-CC (1-4 lowercase ASCII alphanumerics)")]
    BadName(String),
    /// `length` is zero.
    #[error("parameter `{0}`: length must be at least 1")]
    ZeroLength(String),
    /// A `default` slot lies outside `[min, max]`.
    #[error("parameter `{name}`: default[{index}] = {value} outside [{min}, {max}]")]
    DefaultOutOfBounds {
        /// The offending parameter.
        name: String,
        /// The first out-of-bounds slot.
        index: usize,
        /// Its value.
        value: i16,
        /// The declared lower bound.
        min: i16,
        /// The declared upper bound.
        max: i16,
    },
    /// A tristate's `on` value is neither 1 nor 2.
    #[error("parameter `{name}`: tristate `on` must be 1 or 2, got {on}")]
    BadTristateOn {
        /// The offending parameter.
        name: String,
        /// The declared `on` value.
        on: i16,
    },
}

/// The document root: a `[[param]]` array of tables.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(default)]
    param: Vec<ParameterDef>,
}

/// Parses and validates a `parameters.toml` document.
///
/// # Errors
///
/// Returns a [`ParseError`] describing the first malformed entry —
/// TOML/schema errors carry the offending span.
pub fn parse(document: &str) -> Result<Vec<ParameterDef>, ParseError> {
    let document: Document = toml::from_str(document)?;
    let defs = document.param;
    for (i, def) in defs.iter().enumerate() {
        if defs[..i].iter().any(|prior| prior.name == def.name) {
            return Err(ParseError::DuplicateName(def.name.clone()));
        }
        validate(def)?;
    }
    Ok(defs)
}

/// Checks one entry's internal consistency.
fn validate(def: &ParameterDef) -> Result<(), ParseError> {
    let is_4cc = (1..=4).contains(&def.name.len())
        && def
            .name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if !is_4cc {
        return Err(ParseError::BadName(def.name.clone()));
    }
    if def.length == 0 {
        return Err(ParseError::ZeroLength(def.name.clone()));
    }
    if let ParamKind::Tristate { on } = def.kind
        && !matches!(on, 1 | 2)
    {
        return Err(ParseError::BadTristateOn {
            name: def.name.clone(),
            on,
        });
    }
    if def.min > def.max {
        return Err(ParseError::InvertedBounds {
            name: def.name.clone(),
            min: def.min,
            max: def.max,
        });
    }
    if def.default.len() != def.length {
        return Err(ParseError::DefaultLengthMismatch {
            name: def.name.clone(),
            expected: def.length,
            actual: def.default.len(),
        });
    }
    // The engine's power-on state legitimately sits outside the write
    // bounds; the curated table corrects those slots, the twin keeps the
    // engine truth (ADR-0004).
    let bounds = def.min..=def.max;
    if let Some((index, &value)) = def
        .default
        .iter()
        .enumerate()
        .find(|(_, value)| !bounds.contains(value))
    {
        return Err(ParseError::DefaultOutOfBounds {
            name: def.name.clone(),
            index,
            value,
            min: def.min,
            max: def.max,
        });
    }
    Ok(())
}

/// Finds a parameter by 4-CC name.
#[must_use]
pub fn lookup<'a>(defs: &'a [ParameterDef], name: &str) -> Option<&'a ParameterDef> {
    defs.iter().find(|def| def.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal(name: &str) -> String {
        format!(
            r#"
            [[param]]
            name = "{name}"
            length = 1
            min = 0
            max = 10
            frac_bits = 0
            default = [7]
            kind = "integer"
            category = "volume_leveller"
            access = "settable"
            label = "Dolby Volume Leveling Amount"
            description = "Sets how much the leveler adjusts the loudness."
            "#
        )
    }

    #[test]
    fn parses_payload_kinds_and_help() {
        let doc = r#"
            [[param]]
            name = "vdhe"
            length = 1
            min = 0
            max = 2
            frac_bits = 0
            default = [0]
            kind = { tristate = { on = 2 } }
            category = "headphone_virtualizer"
            access = "settable"
            label = "Dolby Headphone Virtualizer Control"
            description = "Enables the headphone virtualizer."
            help = "0 = off, 1 = on, 2 = auto."

            [[param]]
            name = "dvli"
            length = 1
            min = -640
            max = 0
            frac_bits = 4
            default = [-320]
            kind = { decibel = { lkfs = true } }
            category = "volume_leveller"
            access = "settable"
            label = "Dolby Volume Leveler Input Target"
            description = "The reference input loudness."
            "#;
        let defs = parse(doc).unwrap();
        assert_eq!(defs[0].kind, ParamKind::Tristate { on: 2 });
        assert_eq!(defs[0].help, "0 = off, 1 = on, 2 = auto.");
        assert_eq!(defs[1].kind, ParamKind::Decibel { lkfs: true });
        assert_eq!(defs[1].frac_bits, 4);
    }

    #[test]
    fn rejects_a_missing_field() {
        let doc = minimal("dvla").replace("length = 1\n", "");
        let err = parse(&doc).unwrap_err().to_string();
        assert!(err.contains("length"), "unhelpful error: {err}");
    }

    #[test]
    fn rejects_an_unknown_enum_value() {
        let doc = minimal("dvla").replace(r#"access = "settable""#, r#"access = "writable""#);
        let err = parse(&doc).unwrap_err().to_string();
        assert!(err.contains("writable"), "unhelpful error: {err}");
    }

    #[test]
    fn rejects_an_unknown_field() {
        let doc = minimal("dvla") + "basic = true\n";
        let err = parse(&doc).unwrap_err().to_string();
        assert!(err.contains("basic"), "unhelpful error: {err}");
    }

    #[test]
    fn rejects_a_duplicate_name() {
        let doc = minimal("dvla") + &minimal("dvla");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(&err, ParseError::DuplicateName(name) if name == "dvla"));
        assert!(err.to_string().contains("dvla"));
    }

    #[test]
    fn rejects_a_default_of_the_wrong_length() {
        let doc = minimal("dvla").replace("default = [7]", "default = [7, 7]");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::DefaultLengthMismatch { .. }));
        let message = err.to_string();
        assert!(
            message.contains("dvla") && message.contains('2') && message.contains('1'),
            "unhelpful error: {message}"
        );
    }

    #[test]
    fn rejects_a_default_outside_the_write_bounds() {
        // The table is curated: the engine's own out-of-bounds power-on
        // values (`gebf` zero-tails under min = 20, `vnnb` = 0 in [1..20])
        // stay in the twin; every `parameters.toml` slot must be usable.
        let doc = minimal("gebf")
            .replace("min = 0", "min = 20")
            .replace("max = 10", "max = 20000")
            .replace("default = [7]", "default = [40, 0]")
            .replace("length = 1", "length = 2");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::DefaultOutOfBounds { .. }));
        let message = err.to_string();
        assert!(
            message.contains("gebf") && message.contains("[1]") && message.contains("20"),
            "unhelpful error: {message}"
        );
    }

    #[test]
    fn rejects_inverted_bounds() {
        let doc = minimal("dvla").replace("min = 0", "min = 20");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::InvertedBounds { .. }));
    }

    #[test]
    fn rejects_a_bad_4cc_name() {
        for bad in ["", "dolby", "DVLA", "dv a"] {
            let err = parse(&minimal(bad)).unwrap_err();
            assert!(matches!(err, ParseError::BadName(_)), "accepted {bad:?}");
        }
        // 4-CCs shorter than 4 bytes are real: `iea`, `plb`, `vmb`, …
        assert!(parse(&minimal("iea")).is_ok());
    }

    #[test]
    fn rejects_a_zero_length() {
        let doc = minimal("dvla")
            .replace("length = 1", "length = 0")
            .replace("default = [7]", "default = []");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::ZeroLength(name) if name == "dvla"));
    }

    #[test]
    fn rejects_a_tristate_without_a_real_on_value() {
        let doc =
            minimal("vdhe").replace(r#"kind = "integer""#, "kind = { tristate = { on = 3 } }");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::BadTristateOn { .. }));
    }

    #[test]
    fn looks_up_by_name() {
        let doc = minimal("dvla") + &minimal("iea");
        let defs = parse(&doc).unwrap();
        assert_eq!(lookup(&defs, "iea").unwrap().name, "iea");
        assert!(lookup(&defs, "mxou").is_none());
    }

    proptest::proptest! {
        /// Value fields (`min`, `max`, `default`) accept exactly the i16
        /// domain — the engine's native unit, end-to-end.
        #[test]
        fn accepts_value_fields_iff_they_fit_i16(
            value in 4 * i64::from(i16::MIN)..=4 * i64::from(i16::MAX),
        ) {
            let fits = i16::try_from(value).is_ok();
            let as_min = minimal("dvla")
                .replace("min = 0", &format!("min = {}", value.min(0)))
                .replace("default = [7]", "default = [0]");
            let as_max = minimal("dvla")
                .replace("max = 10", &format!("max = {}", value.max(0)))
                .replace("default = [7]", "default = [0]");
            let as_default = minimal("dvla")
                .replace("min = 0", &format!("min = {}", i16::MIN))
                .replace("max = 10", &format!("max = {}", i16::MAX))
                .replace("default = [7]", &format!("default = [{value}]"));
            proptest::prop_assert_eq!(parse(&as_min).is_ok(), i16::try_from(value.min(0)).is_ok());
            proptest::prop_assert_eq!(parse(&as_max).is_ok(), i16::try_from(value.max(0)).is_ok());
            proptest::prop_assert_eq!(parse(&as_default).is_ok(), fits);
        }
    }

    #[test]
    fn parses_a_minimal_param() {
        let defs = parse(&minimal("dvla")).unwrap();
        assert_eq!(defs.len(), 1);
        let def = &defs[0];
        assert_eq!(def.name, "dvla");
        assert_eq!(def.length, 1);
        assert_eq!(def.min, 0);
        assert_eq!(def.max, 10);
        assert_eq!(def.frac_bits, 0);
        assert_eq!(def.default, vec![7]);
        assert_eq!(def.kind, ParamKind::Integer);
        assert_eq!(def.category, ParamCategory::VolumeLeveller);
        assert_eq!(def.access, ParamAccess::Settable);
        assert_eq!(def.label, "Dolby Volume Leveling Amount");
        assert!(def.help.is_empty());
    }
}
