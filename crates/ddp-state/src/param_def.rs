//! The `ParameterDef` table — the single source of truth for AK parameter
//! metadata, parsed from a runtime `parameters.toml`.
//!
//! Everything downstream — wire validation, engine init, persistence, UI
//! generation, ranges — derives from this table
//! ([ADR-0004](https://github.com/avisek/DolbyX/blob/main/docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).
//! The table is curated and validation-clean — every `default` slot in
//! `[min, max]`; CI checks its structure against the committed
//! `parameters.engine.toml` twin: names 1:1, lengths equal, ranges
//! within the engine envelope. Display composition is the `[[category]]`
//! table beside it — section order, labels, card order — and every
//! param's `category` derives from it (ADR-0004 addendum).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Metadata for one AK parameter (one root leaf of the engine's AK tree).
/// (`Serialize` feeds the UI bootstrap; the wire shape mirrors the TOML
/// row plus the derived `category`.)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
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
    /// The Parameter category owning this param — derived at parse from
    /// `[[category]]` membership, never declared on the row.
    pub category: ParamCategory,
    /// Settability bucket.
    pub access: ParamAccess,
    /// Short, category-relative display name (`"Enable"`, `"Amount"`).
    pub label: String,
    /// Engine one-liner.
    pub description: String,
    /// Engine long help — may be empty (absent in TOML ⇒ empty).
    pub help: String,
}

/// One `[[param]]` row as written — [`ParameterDef`] minus the derived
/// `category`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ParamRow {
    name: String,
    length: usize,
    min: i16,
    max: i16,
    frac_bits: u8,
    default: Vec<i16>,
    kind: ParamKind,
    access: ParamAccess,
    label: String,
    description: String,
    #[serde(default)]
    help: String,
}

impl ParamRow {
    fn into_def(self, category: ParamCategory) -> ParameterDef {
        ParameterDef {
            name: self.name,
            length: self.length,
            min: self.min,
            max: self.max,
            frac_bits: self.frac_bits,
            default: self.default,
            kind: self.kind,
            category,
            access: self.access,
            label: self.label,
            description: self.description,
            help: self.help,
        }
    }
}

/// One `[[category]]` row — a Parameter category: table order is
/// section order, `params` order is card order (ADR-0004 addendum).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CategoryDef {
    /// Closed id (`volume_leveller`, `build`, …).
    pub name: ParamCategory,
    /// Section title, as displayed.
    pub label: String,
    /// The 4-CCs it owns, in card order.
    pub params: Vec<String>,
}

/// A parsed `parameters.toml`: both tables, each in file order.
#[derive(Debug, Clone)]
pub struct ParameterTable {
    /// `[[param]]` rows — pinned to the param twin's order.
    pub params: Vec<ParameterDef>,
    /// `[[category]]` rows — display composition.
    pub categories: Vec<CategoryDef>,
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

/// The complete preset-carried param map at `ParameterDef.default` —
/// the base layer beneath the `[eq_preset]` cascade, seeding every EQ
/// preset so each resolves standalone (the nine EQ params of the
/// shipped table).
#[must_use]
pub fn base_eq_params(defs: &[ParameterDef]) -> std::collections::HashMap<String, Vec<i16>> {
    defs.iter()
        .filter(|def| def.access.is_writable() && def.category.is_preset_carried())
        .map(|def| (def.name.clone(), def.default.clone()))
        .collect()
}

/// Splices `values` over the head of the full-length array `name` holds
/// in a resolved param map — the overlay rule for band arrays shorter
/// than the engine-capacity allocation.
///
/// Panics when `name` is not seeded in the map or `values` exceeds its
/// allocation — callers validate against `ParameterDef` first.
pub(crate) fn splice_head(
    params: &mut std::collections::HashMap<String, Vec<i16>>,
    name: &str,
    values: &[i16],
) {
    let current = params
        .get_mut(name)
        .unwrap_or_else(|| panic!("`{name}` is not seeded in this param map"));
    current[..values.len()].copy_from_slice(values);
}

/// Parameter category id — closed: a `[[category]] name` outside it is a
/// schema error.
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
    /// Engine identity slots (`bver ver bndl`).
    Build,
    /// License slots (`lcmf lcvd lcpt`).
    License,
}

impl std::fmt::Display for ParamCategory {
    /// The closed id as the toml spells it (`volume_leveller`).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match toml::Value::try_from(*self) {
            Ok(toml::Value::String(id)) => f.write_str(&id),
            _ => unreachable!("unit variants serialize as strings"),
        }
    }
}

impl ParamCategory {
    /// Whether params of this category are preset-carried — owned by a
    /// selected EQ preset overlay. Eligibility is derived, never
    /// declared: preset-carried ⟺ `category ∈ {Ieq, Geq}` (ADR-0003).
    #[must_use]
    pub const fn is_preset_carried(self) -> bool {
        matches!(self, Self::Ieq | Self::Geq)
    }
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
    /// A `[[param]]` no `[[category]]` lists.
    #[error("parameter `{0}` is listed in no category")]
    UncategorizedParam(String),
    /// A 4-CC listed twice across the `[[category]]` rows (possibly
    /// within one row).
    #[error("parameter `{name}` is listed twice: in `{first}` and `{second}`")]
    ParamListedTwice {
        /// The offending parameter.
        name: String,
        /// The row of its first listing.
        first: ParamCategory,
        /// The row of its second.
        second: ParamCategory,
    },
    /// A `[[category]]` lists a 4-CC no `[[param]]` declares.
    #[error("category `{category}` lists unknown parameter `{name}`")]
    UnknownCategoryParam {
        /// The offending category.
        category: ParamCategory,
        /// The undeclared 4-CC.
        name: String,
    },
    /// Two `[[category]]` rows share a `name`.
    #[error("duplicate category `{0}`")]
    DuplicateCategory(ParamCategory),
    /// A `[[category]]` with an empty `params` list.
    #[error("category `{0}` lists no parameters")]
    EmptyCategory(ParamCategory),
}

/// The document root: `[[category]]` + `[[param]]` arrays of tables.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    #[serde(default)]
    category: Vec<CategoryDef>,
    #[serde(default)]
    param: Vec<ParamRow>,
}

/// Parses and validates a `parameters.toml` document.
///
/// # Errors
///
/// Returns a [`ParseError`] describing the first malformed entry —
/// TOML/schema errors carry the offending span.
pub fn parse(document: &str) -> Result<ParameterTable, ParseError> {
    let document: Document = toml::from_str(document)?;
    let categories = document.category;
    let mut owner: HashMap<&str, ParamCategory> = HashMap::new();
    for (i, row) in categories.iter().enumerate() {
        if categories[..i].iter().any(|prior| prior.name == row.name) {
            return Err(ParseError::DuplicateCategory(row.name));
        }
        if row.params.is_empty() {
            return Err(ParseError::EmptyCategory(row.name));
        }
        for name in &row.params {
            if let Some(first) = owner.insert(name, row.name) {
                return Err(ParseError::ParamListedTwice {
                    name: name.clone(),
                    first,
                    second: row.name,
                });
            }
        }
    }
    let mut params: Vec<ParameterDef> = Vec::with_capacity(document.param.len());
    for row in document.param {
        if params.iter().any(|prior| prior.name == row.name) {
            return Err(ParseError::DuplicateName(row.name));
        }
        let Some(&category) = owner.get(row.name.as_str()) else {
            return Err(ParseError::UncategorizedParam(row.name));
        };
        let def = row.into_def(category);
        validate(&def)?;
        params.push(def);
    }
    if let Some((category, name)) = categories
        .iter()
        .flat_map(|row| row.params.iter().map(move |name| (row.name, name)))
        .find(|(_, name)| lookup(&params, name).is_none())
    {
        return Err(ParseError::UnknownCategoryParam {
            category,
            name: name.clone(),
        });
    }
    Ok(ParameterTable { params, categories })
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

    /// One `[[category]]` row.
    fn category(name: &str, label: &str, params: &[&str]) -> String {
        let params = params
            .iter()
            .map(|p| format!("{p:?}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            r#"
            [[category]]
            name = "{name}"
            label = "{label}"
            params = [{params}]
            "#
        )
    }

    /// One `[[param]]` row — some `[[category]]` must claim it.
    fn param(name: &str) -> String {
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
            access = "settable"
            label = "Amount"
            description = "Sets how much the leveler adjusts the loudness."
            "#
        )
    }

    /// A document with every `name` under one Volume Leveler category.
    fn document(names: &[&str]) -> String {
        names.iter().fold(
            category("volume_leveller", "Volume Leveler", names),
            |doc, name| doc + &param(name),
        )
    }

    fn minimal(name: &str) -> String {
        document(&[name])
    }

    /// Tracer bullet (issue #83): the `[[category]]` table parses in
    /// table order, each row keeping its label and card order, and every
    /// param's `category` is derived from the row listing it.
    #[test]
    fn parses_categories_in_table_order_and_derives_each_params_category() {
        let doc = category("build", "Build", &["bver", "bndl"])
            + &category("license", "License", &["lcmf"])
            + &param("lcmf")
            + &param("bndl")
            + &param("bver");
        let table = parse(&doc).unwrap();
        let names: Vec<_> = table.categories.iter().map(|c| c.name).collect();
        assert_eq!(names, [ParamCategory::Build, ParamCategory::License]);
        assert_eq!(table.categories[0].label, "Build");
        assert_eq!(table.categories[1].label, "License");
        // Card order is the row's, not the `[[param]]` table's.
        assert_eq!(table.categories[0].params, ["bver", "bndl"]);
        assert_eq!(table.categories[1].params, ["lcmf"]);
        let param_names: Vec<_> = table.params.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            param_names,
            ["lcmf", "bndl", "bver"],
            "[[param]] order is kept"
        );
        let category_of = |name| lookup(&table.params, name).unwrap().category;
        assert_eq!(category_of("bver"), ParamCategory::Build);
        assert_eq!(category_of("bndl"), ParamCategory::Build);
        assert_eq!(category_of("lcmf"), ParamCategory::License);
    }

    #[test]
    fn parses_payload_kinds_and_help() {
        let doc = r#"
            [[category]]
            name = "headphone_virtualizer"
            label = "Headphone Virtualizer"
            params = ["vdhe"]

            [[category]]
            name = "volume_leveller"
            label = "Volume Leveler"
            params = ["dvli"]

            [[param]]
            name = "vdhe"
            length = 1
            min = 0
            max = 2
            frac_bits = 0
            default = [0]
            kind = { tristate = { on = 2 } }
            access = "settable"
            label = "Enable"
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
            access = "settable"
            label = "Input Target"
            description = "The reference input loudness."
            "#;
        let defs = parse(doc).unwrap().params;
        assert_eq!(defs[0].kind, ParamKind::Tristate { on: 2 });
        assert_eq!(defs[0].help, "0 = off, 1 = on, 2 = auto.");
        assert_eq!(defs[1].kind, ParamKind::Decibel { lkfs: true });
        assert_eq!(defs[1].frac_bits, 4);
    }

    #[test]
    fn rejects_a_param_listed_in_no_category() {
        let doc = category("volume_leveller", "Volume Leveler", &["dvla"])
            + &param("dvla")
            + &param("dvle");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(&err, ParseError::UncategorizedParam(name) if name == "dvle"));
        assert!(err.to_string().contains("dvle"), "unhelpful error: {err}");
    }

    #[test]
    fn rejects_a_param_still_carrying_a_category_field() {
        // The per-param field is gone (ADR-0004 addendum) — a leftover
        // is a schema error like any unknown field.
        let doc = minimal("dvla") + "category = \"volume_leveller\"\n";
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::Toml(_)));
        assert!(
            err.to_string().contains("category"),
            "unhelpful error: {err}"
        );
    }

    #[test]
    fn rejects_a_param_listed_in_two_categories() {
        let doc = category("volume_leveller", "Volume Leveler", &["dvla", "dvle"])
            + &category("dialog_enhancer", "Dialog Enhancer", &["dvle"])
            + &param("dvla")
            + &param("dvle");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(&err, ParseError::ParamListedTwice { name, .. } if name == "dvle"));
        let message = err.to_string();
        assert!(
            message.contains("dvle")
                && message.contains("volume_leveller")
                && message.contains("dialog_enhancer"),
            "unhelpful error: {message}"
        );
    }

    #[test]
    fn rejects_a_category_naming_an_unknown_4cc() {
        let doc = category("volume_leveller", "Volume Leveler", &["dvla", "mxou"]) + &param("dvla");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(&err, ParseError::UnknownCategoryParam { name, .. } if name == "mxou"));
        let message = err.to_string();
        assert!(
            message.contains("mxou") && message.contains("volume_leveller"),
            "unhelpful error: {message}"
        );
    }

    #[test]
    fn rejects_an_unknown_category_name() {
        // The enum is closed — `build_license` split into `build` +
        // `license` (ADR-0004 addendum).
        let doc = category("build_license", "Build", &["bver"]) + &param("bver");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(err, ParseError::Toml(_)));
        assert!(
            err.to_string().contains("build_license"),
            "unhelpful error: {err}"
        );
    }

    #[test]
    fn rejects_a_duplicate_category_name() {
        let doc = category("volume_leveller", "Volume Leveler", &["dvla"])
            + &category("volume_leveller", "Leveler again", &["dvle"])
            + &param("dvla")
            + &param("dvle");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(
            err,
            ParseError::DuplicateCategory(ParamCategory::VolumeLeveller)
        ));
        assert!(
            err.to_string().contains("volume_leveller"),
            "unhelpful error: {err}"
        );
    }

    #[test]
    fn rejects_an_empty_category() {
        let doc = category("volume_leveller", "Volume Leveler", &["dvla"])
            + &category("build", "Build", &[])
            + &param("dvla");
        let err = parse(&doc).unwrap_err();
        assert!(matches!(
            err,
            ParseError::EmptyCategory(ParamCategory::Build)
        ));
        assert!(err.to_string().contains("build"), "unhelpful error: {err}");
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
        let doc = minimal("dvla") + &param("dvla");
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
        let defs = parse(&document(&["dvla", "iea"])).unwrap().params;
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
        let defs = parse(&minimal("dvla")).unwrap().params;
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
        assert_eq!(def.label, "Amount");
        assert!(def.help.is_empty());
    }
}
