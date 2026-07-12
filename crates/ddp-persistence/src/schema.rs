//! On-disk TOML schemas: `defaults.toml` (factory truth, read-only) and
//! `config.toml` (the user's overlay), each carrying the root keys plus
//! two namespaces — `[profile]` and `[eq_preset]` (presets fill in
//! Slice 15, [#23](https://github.com/avisek/DolbyX/issues/23)).
//!
//! One parse rule per namespace (ADR-0007): a sub-table
//! (`[profile.<id>]`) is one item's params; **any other key is a shared
//! param applying to every item**. Five layers resolve at load, later
//! shadowing earlier:
//!
//! ```text
//! ParameterDef.default → defaults.toml shared → defaults.toml [item]
//!                      →  config.toml  shared →  config.toml  [item]
//! ```
//!
//! Each file stores only divergences from what resolves beneath it, so
//! a factory-fresh install is an **empty** `config.toml`. Write-back is
//! always per-item; the shared layers are a hand-edit affordance the
//! daemon re-emits verbatim, never writes.

use std::collections::HashMap;
use std::fmt::Write as _;

use ddp_state::{Defaults, ParameterDef, Profile, ProfileId, State, base_params, validate_write};
use indexmap::IndexMap;
use serde::Deserialize;

use crate::Error;

/// A param value exactly as TOML declares it — a bare scalar
/// (`dvla = 4`) or an array (`gebg = [0, 0, …]`); the declared form is
/// kept so hand-edits re-emit unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParamValue {
    /// `dvla = 4`
    One(i16),
    /// `gebg = [1, 2]`
    Many(Vec<i16>),
}

impl ParamValue {
    fn as_slice(&self) -> &[i16] {
        match self {
            Self::One(value) => std::slice::from_ref(value),
            Self::Many(values) => values,
        }
    }
}

/// One item table (`[profile.<id>]`): an optional display name plus
/// 4-CC params directly in the table.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ItemTable {
    pub(crate) name: Option<String>,
    pub(crate) params: IndexMap<String, ParamValue>,
}

/// One namespace, split by the parse rule: shared params + item tables,
/// both in document order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Namespace {
    pub(crate) shared: IndexMap<String, ParamValue>,
    pub(crate) items: IndexMap<String, ItemTable>,
}

impl Namespace {
    fn is_empty(&self) -> bool {
        self.shared.is_empty() && self.items.is_empty()
    }
}

/// `defaults.toml` as serde sees it — strict about the root (a missing
/// or unknown key refuses startup), namespaces split afterwards.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DefaultsFile {
    power: bool,
    selected_profile: ProfileId,
    #[serde(default)]
    profile: IndexMap<String, toml::Value>,
    #[serde(default)]
    eq_preset: IndexMap<String, toml::Value>,
}

/// `config.toml` as serde sees it — sparse by design (empty on a fresh
/// install), strict about unknown root keys so a hand-edit typo fails
/// loudly.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    power: Option<bool>,
    selected_profile: Option<ProfileId>,
    #[serde(default)]
    profile: IndexMap<String, toml::Value>,
    #[serde(default)]
    eq_preset: IndexMap<String, toml::Value>,
}

/// The user's parsed + validated overlay. The namespaces keep their
/// declared form: the shared layers and the `[eq_preset]` tables are
/// re-emitted verbatim on write-back (hand-edit affordance; presets
/// take effect in Slice 15,
/// [#23](https://github.com/avisek/DolbyX/issues/23)).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigOverlay {
    pub(crate) power: Option<bool>,
    pub(crate) selected_profile: Option<ProfileId>,
    pub(crate) profile: Namespace,
    pub(crate) eq_preset: Namespace,
}

/// Splits a namespace table by the parse rule — sub-table ⇒ item,
/// anything else ⇒ shared param — with the value shapes checked.
fn split_namespace(table: IndexMap<String, toml::Value>) -> Result<Namespace, String> {
    let mut namespace = Namespace::default();
    for (key, value) in table {
        match value {
            toml::Value::Table(item) => {
                let item = split_item(&key, item)?;
                namespace.items.insert(key, item);
            }
            other => {
                let value = param_value(&key, other)?;
                namespace.shared.insert(key, value);
            }
        }
    }
    Ok(namespace)
}

/// Reads one item table: `name` is the display name, every other key a
/// param.
fn split_item(id: &str, table: toml::Table) -> Result<ItemTable, String> {
    let mut item = ItemTable::default();
    for (key, value) in table {
        if key == "name" {
            match value {
                toml::Value::String(name) => item.name = Some(name),
                other => return Err(format!("[{id}]: `name` must be a string, got {other}")),
            }
        } else {
            let value = param_value(&format!("{id}.{key}"), value)?;
            item.params.insert(key, value);
        }
    }
    Ok(item)
}

/// Reads one param value — an i16 scalar or an i16 array.
fn param_value(key: &str, value: toml::Value) -> Result<ParamValue, String> {
    let scalar = |value: &toml::Value| match value {
        toml::Value::Integer(scalar) => i16::try_from(*scalar)
            .map_err(|_| format!("`{key}`: {scalar} does not fit i16 (engine-native units)")),
        other => Err(format!("`{key}`: expected an integer, got {other}")),
    };
    match value {
        toml::Value::Array(values) => Ok(ParamValue::Many(
            values.iter().map(scalar).collect::<Result<_, _>>()?,
        )),
        other => Ok(ParamValue::One(scalar(&other)?)),
    }
}

/// Validates every param of a namespace against the `ParameterDef`
/// table — declared, writable, shape and range (the load-time face of
/// the epic's validation rule).
fn validate_namespace(defs: &[ParameterDef], namespace: &Namespace) -> Result<(), String> {
    let entries = namespace
        .shared
        .iter()
        .chain(namespace.items.values().flat_map(|item| item.params.iter()));
    for (name, value) in entries {
        validate_write(defs, name, value.as_slice()).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Splices a layer's params over `params` — shorter band arrays overlay
/// the head of the full-length allocation.
fn overlay_params(params: &mut HashMap<String, Vec<i16>>, layer: &IndexMap<String, ParamValue>) {
    for (name, value) in layer {
        let values = value.as_slice();
        params.get_mut(name).expect("layers are validated")[..values.len()].copy_from_slice(values);
    }
}

/// Parses `defaults.toml` into the factory truth: root keys + the
/// factory profiles, each resolved `ParameterDef.default` ⊕ shared ⊕
/// item, in declaration order.
///
/// # Errors
///
/// [`Error::Defaults`] when the document is malformed, a param fails
/// validation against `defs`, a profile lacks a `name`, or
/// `selected_profile` names no profile — the daemon refuses to start.
pub fn parse_defaults(document: &str, defs: &[ParameterDef]) -> Result<Defaults, Error> {
    let file: DefaultsFile =
        toml::from_str(document).map_err(|e| Error::Defaults(e.to_string()))?;
    let profile = split_namespace(file.profile).map_err(Error::Defaults)?;
    let eq_preset = split_namespace(file.eq_preset).map_err(Error::Defaults)?;
    if !eq_preset.is_empty() {
        return Err(Error::Defaults(
            "[eq_preset] factory rows arrive with EQ presets (Slice 15)".into(),
        ));
    }
    validate_namespace(defs, &profile).map_err(Error::Defaults)?;

    let mut profiles = Vec::with_capacity(profile.items.len());
    for (id, item) in &profile.items {
        let name = item.name.clone().ok_or_else(|| {
            Error::Defaults(format!("[profile.{id}]: missing `name` (display name)"))
        })?;
        let mut params = base_params(defs);
        overlay_params(&mut params, &profile.shared);
        overlay_params(&mut params, &item.params);
        profiles.push(Profile {
            id: ProfileId(id.clone()),
            name,
            selected_eq_preset: None,
            is_factory: true,
            params: params.clone(),
            baseline: params,
        });
    }
    let defaults = Defaults {
        power: file.power,
        selected_profile: file.selected_profile,
        profiles,
    };
    if defaults
        .profiles
        .iter()
        .all(|profile| profile.id != defaults.selected_profile)
    {
        return Err(Error::Defaults(format!(
            "selected_profile `{}` names no profile",
            defaults.selected_profile.0
        )));
    }
    Ok(defaults)
}

/// Parses `config.toml` into the user's overlay, validated against the
/// param table and the factory truth.
///
/// # Errors
///
/// [`Error::Config`] when the document is malformed, a param fails
/// validation, an item names an unknown profile (custom profiles arrive
/// in Slice 18), a factory row carries a rename, or `selected_profile`
/// dangles — refuse to start rather than silently discard user state.
pub fn parse_config(
    document: &str,
    defs: &[ParameterDef],
    defaults: &Defaults,
) -> Result<ConfigOverlay, Error> {
    let file: ConfigFile = toml::from_str(document).map_err(|e| Error::Config(e.to_string()))?;
    let profile = split_namespace(file.profile).map_err(Error::Config)?;
    let eq_preset = split_namespace(file.eq_preset).map_err(Error::Config)?;
    validate_namespace(defs, &profile).map_err(Error::Config)?;
    validate_namespace(defs, &eq_preset).map_err(Error::Config)?;

    let known = |id: &ProfileId| defaults.profiles.iter().any(|profile| profile.id == *id);
    for (id, item) in &profile.items {
        if !known(&ProfileId(id.clone())) {
            return Err(Error::Config(format!(
                "[profile.{id}]: unknown profile (custom profiles arrive in Slice 18)"
            )));
        }
        if item.name.is_some() {
            return Err(Error::Config(format!(
                "[profile.{id}]: factory profiles cannot be renamed"
            )));
        }
    }
    if let Some(selected) = &file.selected_profile
        && !known(selected)
    {
        return Err(Error::Config(format!(
            "selected_profile `{}` names no profile",
            selected.0
        )));
    }
    Ok(ConfigOverlay {
        power: file.power,
        selected_profile: file.selected_profile,
        profile,
        eq_preset,
    })
}

/// Resolves the user overlay over the factory defaults into a
/// [`State`]: per profile, `baseline` = factory ⊕ config-shared and
/// `params` = baseline ⊕ config-item — complete at load, so a profile
/// switch pushes one atomic batch with no per-param fallback.
#[must_use]
pub fn resolve(defaults: &Defaults, overlay: &ConfigOverlay) -> State {
    let mut state = State::new_from_defaults(defaults);
    state.power = overlay.power.unwrap_or(defaults.power);
    if let Some(selected) = &overlay.selected_profile {
        state.selected_profile = selected.clone();
    }
    for profile in &mut state.profiles {
        overlay_params(&mut profile.baseline, &overlay.profile.shared);
        profile.params = profile.baseline.clone();
        if let Some(item) = overlay.profile.items.get(&profile.id.0) {
            overlay_params(&mut profile.params, &item.params);
        }
    }
    state
}

/// Serializes the divergence of `state` from the factory truth — the
/// exact bytes `config.toml` should hold. Root keys and `[profile.<id>]`
/// tables carry only divergences (per-item write-back); the shared
/// layers and `[eq_preset]` namespace re-emit from `loaded` verbatim.
/// No divergence and no hand-edits ⇒ the empty string (a 0-byte file).
#[must_use]
pub fn serialize_overlay(
    state: &State,
    defaults: &Defaults,
    loaded: &ConfigOverlay,
    defs: &[ParameterDef],
) -> String {
    let mut doc = String::new();
    if state.power != defaults.power {
        emit_value(&mut doc, "power", &toml_bool(state.power));
    }
    if state.selected_profile != defaults.selected_profile {
        emit_value(
            &mut doc,
            "selected_profile",
            &toml_string(&state.selected_profile.0),
        );
    }

    emit_shared(&mut doc, "profile", &loaded.profile.shared);
    for profile in &state.profiles {
        let mut item = String::new();
        for def in defs {
            let Some(values) = profile.params.get(&def.name) else {
                continue;
            };
            if *values != profile.baseline[&def.name] {
                emit_value(&mut item, &def.name, &toml_values(values));
            }
        }
        if !item.is_empty() {
            let _ = write!(doc, "\n[profile.{}]\n{item}", profile.id.0);
        }
    }

    emit_shared(&mut doc, "eq_preset", &loaded.eq_preset.shared);
    for (id, item) in &loaded.eq_preset.items {
        let _ = write!(doc, "\n[eq_preset.{id}]\n");
        if let Some(name) = &item.name {
            emit_value(&mut doc, "name", &toml_string(name));
        }
        for (name, value) in &item.params {
            emit_value(&mut doc, name, &toml_param(value));
        }
    }

    // A document that opens with a table header needs no separator.
    match doc.strip_prefix('\n') {
        Some(stripped) => stripped.to_string(),
        None => doc,
    }
}

/// Emits a namespace's shared layer verbatim, when it has one.
fn emit_shared(doc: &mut String, namespace: &str, shared: &IndexMap<String, ParamValue>) {
    if shared.is_empty() {
        return;
    }
    let _ = write!(doc, "\n[{namespace}]\n");
    for (name, value) in shared {
        emit_value(doc, name, &toml_param(value));
    }
}

fn emit_value(doc: &mut String, key: &str, value: &str) {
    let _ = writeln!(doc, "{key} = {value}");
}

fn toml_bool(value: bool) -> String {
    value.to_string()
}

/// A TOML basic string with the characters that need it escaped.
fn toml_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => {
                let _ = write!(out, "\\u{:04X}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A stored param as TOML: single values as bare scalars, band arrays
/// as arrays.
fn toml_values(values: &[i16]) -> String {
    match values {
        [value] => value.to_string(),
        values => format!(
            "[{}]",
            values
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// A loaded param re-emitted in its declared form.
fn toml_param(value: &ParamValue) -> String {
    match value {
        ParamValue::One(value) => value.to_string(),
        ParamValue::Many(values) => format!(
            "[{}]",
            values
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use ddp_state::{Command, ParamAccess, ParamCategory, ParamKind};

    use super::*;

    /// A compact table: a scalar, a band array (allocation 4), an
    /// experimental scalar, a read-only.
    fn defs() -> Vec<ParameterDef> {
        let def = |name: &str, length: usize, min: i16, max: i16, default: Vec<i16>, access| {
            ParameterDef {
                name: name.into(),
                length,
                min,
                max,
                frac_bits: 0,
                default,
                kind: ParamKind::Integer,
                category: ParamCategory::VolumeLeveller,
                access,
                label: name.to_uppercase(),
                description: String::new(),
                help: String::new(),
            }
        };
        vec![
            def("dvla", 1, 0, 10, vec![7], ParamAccess::Settable),
            def(
                "gebf",
                4,
                20,
                20000,
                vec![32, 64, 20, 20],
                ParamAccess::Settable,
            ),
            def("ven", 1, 0, 1, vec![0], ParamAccess::Experimental),
            def("vnnb", 1, 1, 20, vec![20], ParamAccess::ReadOnlyStatic),
        ]
    }

    const DEFAULTS: &str = r#"
power = true
selected_profile = "music"

[profile]
ven = 1
gebf = [43, 129, 215]

[profile.movie]
name = "Movie"

[profile.music]
name = "Music"
dvla = 4
"#;

    fn defaults() -> Defaults {
        parse_defaults(DEFAULTS, &defs()).unwrap()
    }

    /// Behavior 1 (issue #18): factory profiles resolve their declared
    /// overrides; shared `[profile]` keys apply to every profile;
    /// shorter band arrays overlay the head of the allocation.
    #[test]
    fn parses_defaults_with_shared_keys_applying_to_every_profile() {
        let defaults = defaults();
        assert!(defaults.power);
        assert_eq!(defaults.selected_profile, ProfileId("music".into()));

        let ids: Vec<&str> = defaults
            .profiles
            .iter()
            .map(|profile| profile.id.0.as_str())
            .collect();
        assert_eq!(ids, ["movie", "music"], "declaration order");

        let movie = &defaults.profiles[0];
        let music = &defaults.profiles[1];
        assert_eq!(movie.name, "Movie");
        assert!(movie.is_factory);
        assert_eq!(movie.params["ven"], vec![1], "shared applies to movie");
        assert_eq!(music.params["ven"], vec![1], "shared applies to music");
        assert_eq!(movie.params["dvla"], vec![7], "movie runs the base default");
        assert_eq!(music.params["dvla"], vec![4], "music runs its override");
        assert_eq!(
            music.params["gebf"],
            vec![43, 129, 215, 20],
            "a 3-value grid overlays the head; the tail keeps the base"
        );
        assert!(
            !movie.params.contains_key("vnnb"),
            "read-only params never enter a profile"
        );
        assert_eq!(music.baseline, music.params, "no user layers yet");
    }

    #[test]
    fn rejects_malformed_or_invalid_defaults() {
        let cases = [
            ("power = true\n", "selected_profile"),
            ("power = tru", "expected"),
            (
                DEFAULTS
                    .replace("power = true", "power = true\nx = 1")
                    .leak(),
                "x",
            ),
            (DEFAULTS.replace("dvla = 4", "dvla = 11").leak(), "outside"),
            (DEFAULTS.replace("dvla = 4", "vnnb = 5").leak(), "read-only"),
            (
                DEFAULTS.replace("dvla = 4", "mxou = 1").leak(),
                "unknown parameter",
            ),
            (DEFAULTS.replace("dvla = 4", "dvla = 40000").leak(), "i16"),
            (DEFAULTS.replace("name = \"Movie\"\n", "").leak(), "name"),
            (
                DEFAULTS
                    .replace("selected_profile = \"music\"", "selected_profile = \"x\"")
                    .leak(),
                "names no profile",
            ),
            (
                DEFAULTS
                    .replace("[profile.movie]", "[eq_preset.rich]")
                    .leak(),
                "Slice 15",
            ),
        ];
        for (document, needle) in cases {
            let error = parse_defaults(document, &defs()).unwrap_err().to_string();
            assert!(
                error.contains("defaults.toml") && error.contains(needle),
                "wanted {needle:?} in: {error}"
            );
        }
    }

    #[test]
    fn parses_an_empty_config_as_no_overlay() {
        let overlay = parse_config("", &defs(), &defaults()).unwrap();
        assert_eq!(overlay, ConfigOverlay::default());
    }

    #[test]
    fn rejects_invalid_config() {
        let cases = [
            ("powr = false\n", "powr"),
            ("[profile.gost]\ndvla = 1\n", "unknown profile"),
            ("[profile.music]\nname = \"Loud\"\n", "renamed"),
            ("[profile.music]\ndvla = 99\n", "outside"),
            ("[profile]\nvnnb = 5\n", "read-only"),
            ("[eq_preset.x]\ndvla = 99\n", "outside"),
            ("selected_profile = \"ghost\"\n", "names no profile"),
        ];
        for (document, needle) in cases {
            let error = parse_config(document, &defs(), &defaults())
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("config.toml") && error.contains(needle),
                "wanted {needle:?} in: {error}"
            );
        }
    }

    /// Behavior 3 (issue #18), table-driven: the five layers resolve in
    /// order, later shadowing earlier.
    #[test]
    fn the_cascade_resolves_later_layers_over_earlier_ones() {
        let defs = defs();
        let layers = [
            ("", "", vec![7_i16], "ParameterDef.default"),
            ("dvla = 6", "", vec![6], "defaults shared"),
            ("dvla = 6", "dvla = 5", vec![5], "defaults item"),
            // The config layers stack on a defaults file carrying both
            // defaults layers, proving shared-under-item shadowing too.
            ("cfg-shared", "", vec![3], "config shared"),
            ("cfg-shared", "cfg-item", vec![2], "config item"),
        ];
        for (first, second, expected, layer) in layers {
            let (defaults_doc, config_doc) = match first {
                "cfg-shared" => (
                    "power = true\nselected_profile = \"music\"\n[profile]\ndvla = 6\n[profile.music]\nname = \"Music\"\ndvla = 5\n".to_string(),
                    if second.is_empty() {
                        "[profile]\ndvla = 3\n".to_string()
                    } else {
                        "[profile]\ndvla = 3\n[profile.music]\ndvla = 2\n".to_string()
                    },
                ),
                shared => (
                    format!(
                        "power = true\nselected_profile = \"music\"\n[profile]\n{shared}\n[profile.music]\nname = \"Music\"\n{second}\n"
                    ),
                    String::new(),
                ),
            };
            let defaults = parse_defaults(&defaults_doc, &defs).unwrap();
            let overlay = parse_config(&config_doc, &defs, &defaults).unwrap();
            let state = resolve(&defaults, &overlay);
            assert_eq!(state.selected().params["dvla"], expected, "layer: {layer}");
        }
    }

    /// The baseline is what resolves beneath the item's own overrides —
    /// config-shared included — so reset lands there, not at factory.
    #[test]
    fn resolve_sets_the_baseline_beneath_the_item_layer() {
        let defs = defs();
        let defaults = defaults();
        let overlay = parse_config(
            "[profile]\ndvla = 3\n[profile.music]\ndvla = 2\n",
            &defs,
            &defaults,
        )
        .unwrap();
        let mut state = resolve(&defaults, &overlay);
        assert_eq!(state.selected().params["dvla"], vec![2]);
        assert_eq!(state.selected().baseline["dvla"], vec![3]);

        let _ = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                },
                &defs,
            )
            .unwrap();
        assert_eq!(
            state.selected().params["dvla"],
            vec![3],
            "reset restores config-shared, not factory"
        );
    }

    /// Behavior 6 (issue #18), serialization half: only divergences from
    /// the baseline are written, per item; factory values never land in
    /// config.toml.
    #[test]
    fn serializes_only_divergences_from_the_baseline() {
        let defs = defs();
        let defaults = defaults();
        let loaded = ConfigOverlay::default();
        let mut state = resolve(&defaults, &loaded);
        assert_eq!(serialize_overlay(&state, &defaults, &loaded, &defs), "");

        let _ = state.apply(Command::SetPower { on: false }, &defs).unwrap();
        assert_eq!(
            serialize_overlay(&state, &defaults, &loaded, &defs),
            "power = false\n"
        );

        let _ = state
            .apply(
                Command::SetProfile {
                    id: ProfileId("movie".into()),
                },
                &defs,
            )
            .unwrap();
        let _ = state.apply(Command::SetPower { on: true }, &defs).unwrap();
        assert_eq!(
            serialize_overlay(&state, &defaults, &loaded, &defs),
            "selected_profile = \"movie\"\n"
        );

        let _ = state
            .apply(
                Command::EditProfile {
                    id: ProfileId("music".into()),
                    params: [("dvla".to_string(), vec![5_i16])].into(),
                },
                &defs,
            )
            .unwrap();
        let _ = state
            .apply(
                Command::EditProfile {
                    id: ProfileId("movie".into()),
                    params: [("gebf".to_string(), vec![99_i16, 64])].into(),
                },
                &defs,
            )
            .unwrap();
        assert_eq!(
            serialize_overlay(&state, &defaults, &loaded, &defs),
            "selected_profile = \"movie\"\n\n[profile.movie]\ngebf = [99, 64, 215, 20]\n\n[profile.music]\ndvla = 5\n",
            "scalars bare, band arrays full-length; items in profile order"
        );

        // Round-trip: the written overlay reloads to the same state.
        let document = serialize_overlay(&state, &defaults, &loaded, &defs);
        let reloaded = resolve(
            &defaults,
            &parse_config(&document, &defs, &defaults).unwrap(),
        );
        assert_eq!(reloaded, state);
    }

    /// Hand-edited shared layers and `[eq_preset]` tables survive a
    /// write-back verbatim — the daemon writes per-item only.
    #[test]
    fn write_back_preserves_hand_edited_shared_and_eq_preset_layers() {
        let defs = defs();
        let defaults = defaults();
        let hand_edited = "\
[profile]
dvla = 3
gebf = [50, 60]

[eq_preset]
ven = 1

[eq_preset.warm]
name = \"Warm\"
gebf = [44, 55]
";
        let loaded = parse_config(hand_edited, &defs, &defaults).unwrap();
        let mut state = resolve(&defaults, &loaded);
        let _ = state
            .apply(
                Command::EditProfile {
                    id: ProfileId("music".into()),
                    params: [("dvla".to_string(), vec![9_i16])].into(),
                },
                &defs,
            )
            .unwrap();

        let written = serialize_overlay(&state, &defaults, &loaded, &defs);
        assert_eq!(
            written,
            "\
[profile]
dvla = 3
gebf = [50, 60]

[profile.music]
dvla = 9

[eq_preset]
ven = 1

[eq_preset.warm]
name = \"Warm\"
gebf = [44, 55]
",
        );
        // And the preserved document parses right back.
        let reloaded = parse_config(&written, &defs, &defaults).unwrap();
        assert_eq!(reloaded.profile.shared, loaded.profile.shared);
        assert_eq!(reloaded.eq_preset, loaded.eq_preset);
    }
}
