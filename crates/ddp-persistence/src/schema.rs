//! On-disk TOML schemas: `defaults.toml` (factory truth, read-only) and
//! `config.toml` (the user's overlay), each carrying the root keys plus
//! two namespaces — `[profile]` and `[eq_preset]`.
//!
//! One parse rule per namespace (ADR-0007): a sub-table
//! (`[profile.<id>]`) is one item's params; **any other key is a shared
//! param applying to every item** (profile items also carry the
//! reserved `name` / `selected_eq_preset` keys, preset items `name`).
//! Five layers resolve at load, later shadowing earlier:
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

use ddp_state::{
    Defaults, EqPreset, ParameterDef, PresetContent, PresetId, Profile, ProfileContent, ProfileId,
    State, ValidationError, base_eq_params, base_params, validate_eq_preset_write, validate_write,
};
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

/// One item table (`[profile.<id>]` / `[eq_preset.<id>]`): the reserved
/// keys plus 4-CC params directly in the table.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ItemTable {
    pub(crate) name: Option<String>,
    /// The profile row's stated EQ selection (ADR-0007): key absent =
    /// outer `None` (inherit what resolves beneath), the reserved
    /// `"none"` sentinel = `Some(None)` (a diverging no-preset), an
    /// id = `Some(Some(id))`. Profile items only — `defaults.toml`
    /// rows must name a defaults preset (never the sentinel); preset
    /// rows reject it everywhere.
    #[expect(
        clippy::option_option,
        reason = "the row's statement: key absent ≠ \"none\" ≠ id (ADR-0007)"
    )]
    pub(crate) selected_eq_preset: Option<Option<PresetId>>,
    pub(crate) params: IndexMap<String, ParamValue>,
}

/// One namespace, split by the parse rule: shared params + item tables,
/// both in document order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Namespace {
    pub(crate) shared: IndexMap<String, ParamValue>,
    pub(crate) items: IndexMap<String, ItemTable>,
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
/// declared form: the shared layers are re-emitted verbatim on
/// write-back (a hand-edit affordance the daemon never writes).
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

/// Reads one item table: `name` and `selected_eq_preset` are reserved
/// keys, every other key a param.
fn split_item(id: &str, table: toml::Table) -> Result<ItemTable, String> {
    let mut item = ItemTable::default();
    for (key, value) in table {
        match (key.as_str(), value) {
            ("name", toml::Value::String(name)) => item.name = Some(name),
            ("name", other) => {
                return Err(format!("[{id}]: `name` must be a string, got {other}"));
            }
            ("selected_eq_preset", toml::Value::String(preset)) => {
                item.selected_eq_preset = Some(match preset.as_str() {
                    "none" => None, // the reserved explicit no-preset sentinel
                    _ => Some(PresetId(preset)),
                });
            }
            ("selected_eq_preset", other) => {
                return Err(format!(
                    "[{id}]: `selected_eq_preset` must be a preset id string, got {other}"
                ));
            }
            (_, value) => {
                let value = param_value(&format!("{id}.{key}"), value)?;
                item.params.insert(key, value);
            }
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

/// A per-entry param validator: [`validate_write`] for `[profile]`,
/// [`validate_eq_preset_write`] for `[eq_preset]` (presets carry only the
/// preset-carried params).
type ParamValidator = fn(&[ParameterDef], &str, &[i16]) -> Result<(), ValidationError>;

/// Validates every param of a namespace against the `ParameterDef`
/// table — declared, writable, shape and range (the load-time face of
/// the epic's validation rule).
fn validate_namespace(
    defs: &[ParameterDef],
    namespace: &Namespace,
    validate: ParamValidator,
) -> Result<(), String> {
    let entries = namespace
        .shared
        .iter()
        .chain(namespace.items.values().flat_map(|item| item.params.iter()));
    for (name, value) in entries {
        validate(defs, name, value.as_slice()).map_err(|error| error.to_string())?;
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
/// factory profiles and EQ presets, each resolved
/// `ParameterDef.default` ⊕ shared ⊕ item, in declaration order (the
/// `[eq_preset]` shared layer gives presets their band structure, so
/// each resolves standalone — issue #23).
///
/// # Errors
///
/// [`Error::Defaults`] when the document is malformed, a param fails
/// validation against `defs`, an item lacks a `name` or claims the
/// reserved id `none`, a profile row's `selected_eq_preset` names no
/// `defaults.toml` preset (the `"none"` sentinel included — it encodes
/// a *diverging* no-preset, meaningless here), or `selected_profile`
/// names no profile — the daemon refuses to start.
pub fn parse_defaults(document: &str, defs: &[ParameterDef]) -> Result<Defaults, Error> {
    let file: DefaultsFile =
        toml::from_str(document).map_err(|e| Error::Defaults(e.to_string()))?;
    let profile = split_namespace(file.profile).map_err(Error::Defaults)?;
    let eq_preset = split_namespace(file.eq_preset).map_err(Error::Defaults)?;
    validate_namespace(defs, &profile, validate_write).map_err(Error::Defaults)?;
    validate_namespace(defs, &eq_preset, validate_eq_preset_write).map_err(Error::Defaults)?;

    let mut eq_presets = Vec::with_capacity(eq_preset.items.len());
    for (id, item) in &eq_preset.items {
        reject_reserved_id("eq_preset", id).map_err(Error::Defaults)?;
        let name = item.name.clone().ok_or_else(|| {
            Error::Defaults(format!("[eq_preset.{id}]: missing `name` (display name)"))
        })?;
        reject_eq_selection(id, item).map_err(Error::Defaults)?;
        let mut params = base_eq_params(defs);
        overlay_params(&mut params, &eq_preset.shared);
        overlay_params(&mut params, &item.params);
        let content = PresetContent { params };
        eq_presets.push(EqPreset {
            id: PresetId(id.clone()),
            name,
            is_factory: true,
            content: content.clone(),
            baseline: content,
        });
    }

    let mut profiles = Vec::with_capacity(profile.items.len());
    for (id, item) in &profile.items {
        reject_reserved_id("profile", id).map_err(Error::Defaults)?;
        let name = item.name.clone().ok_or_else(|| {
            Error::Defaults(format!("[profile.{id}]: missing `name` (display name)"))
        })?;
        // A row MAY ship a factory EQ selection (ADR-0007) — it must
        // name a defaults.toml preset; the sentinel encodes a
        // *diverging* no-preset, meaningless where nothing resolves
        // beneath.
        let eq_selection = match &item.selected_eq_preset {
            None => None,
            Some(None) => {
                return Err(Error::Defaults(format!(
                    "[profile.{id}]: `selected_eq_preset` must name a defaults.toml preset \
                     (`\"none\"` is config.toml's diverging no-preset sentinel)"
                )));
            }
            Some(Some(preset)) => {
                if !eq_preset.items.contains_key(&preset.0) {
                    return Err(Error::Defaults(format!(
                        "[profile.{id}]: selected_eq_preset `{}` names no EQ preset",
                        preset.0
                    )));
                }
                Some(preset.clone())
            }
        };
        let mut params = base_params(defs);
        overlay_params(&mut params, &profile.shared);
        overlay_params(&mut params, &item.params);
        let content = ProfileContent {
            selected_eq_preset: eq_selection,
            params,
        };
        profiles.push(Profile {
            id: ProfileId(id.clone()),
            name,
            is_factory: true,
            content: content.clone(),
            baseline: content,
        });
    }
    let mut custom_profile_params = base_params(defs);
    overlay_params(&mut custom_profile_params, &profile.shared);
    let mut custom_eq_preset_params = base_eq_params(defs);
    overlay_params(&mut custom_eq_preset_params, &eq_preset.shared);
    let defaults = Defaults {
        power: file.power,
        selected_profile: file.selected_profile,
        profiles,
        eq_presets,
        // Customs never have an EQ selection beneath: no defaults.toml
        // row, and the shared tables stay params-only (ADR-0007).
        custom_profile_baseline: ProfileContent {
            selected_eq_preset: None,
            params: custom_profile_params,
        },
        custom_eq_preset_baseline: PresetContent {
            params: custom_eq_preset_params,
        },
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

/// `selected_eq_preset` belongs on profile items only.
fn reject_eq_selection(id: &str, item: &ItemTable) -> Result<(), String> {
    if item.selected_eq_preset.is_some() {
        return Err(format!(
            "[eq_preset.{id}]: `selected_eq_preset` applies to profiles only"
        ));
    }
    Ok(())
}

/// No item — either file, either namespace — may claim the reserved id
/// `none`: a row under it would make every `selected_eq_preset =
/// "none"` ambiguous (ADR-0007).
fn reject_reserved_id(namespace: &str, id: &str) -> Result<(), String> {
    if id == "none" {
        return Err(format!(
            "[{namespace}.none]: the id `none` is reserved (the explicit no-preset sentinel)"
        ));
    }
    Ok(())
}

/// Parses `config.toml` into the user's overlay, validated against the
/// param table and the factory truth. An item row whose id `defaults.toml`
/// doesn't ship is a **custom item** (issue #26): its id is the table
/// key, its `name` lives in the row.
///
/// # Errors
///
/// [`Error::Config`] when the document is malformed, a param fails
/// validation, a factory row carries a rename, a custom row lacks its
/// `name` or claims the reserved id `none`, or a stated selection
/// (`selected_profile` / a profile's `selected_eq_preset`) dangles —
/// refuse to start rather than silently discard user state.
pub fn parse_config(
    document: &str,
    defs: &[ParameterDef],
    defaults: &Defaults,
) -> Result<ConfigOverlay, Error> {
    let file: ConfigFile = toml::from_str(document).map_err(|e| Error::Config(e.to_string()))?;
    let profile = split_namespace(file.profile).map_err(Error::Config)?;
    let eq_preset = split_namespace(file.eq_preset).map_err(Error::Config)?;
    validate_namespace(defs, &profile, validate_write).map_err(Error::Config)?;
    validate_namespace(defs, &eq_preset, validate_eq_preset_write).map_err(Error::Config)?;

    let factory_profile = |id: &str| defaults.profiles.iter().any(|profile| profile.id.0 == id);
    let factory_preset = |id: &str| defaults.eq_presets.iter().any(|preset| preset.id.0 == id);
    for (id, item) in &eq_preset.items {
        validate_row_identity("eq_preset", id, item, factory_preset(id)).map_err(Error::Config)?;
        reject_eq_selection(id, item).map_err(Error::Config)?;
    }
    // An EQ selection may name a factory preset or any custom row above.
    let known_preset = |id: &PresetId| factory_preset(&id.0) || eq_preset.items.contains_key(&id.0);
    for (id, item) in &profile.items {
        validate_row_identity("profile", id, item, factory_profile(id)).map_err(Error::Config)?;
        if let Some(Some(preset)) = &item.selected_eq_preset
            && !known_preset(preset)
        {
            return Err(Error::Config(format!(
                "[profile.{id}]: selected_eq_preset `{}` names no EQ preset",
                preset.0
            )));
        }
    }
    if let Some(selected) = &file.selected_profile
        && !factory_profile(&selected.0)
        && !profile.items.contains_key(&selected.0)
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

/// The id + `name` rules per row kind: factory rows never carry a
/// `name` (their shipped names are fixed), custom rows must (the id is
/// the table key, the display name lives in the row — ADR-0007) — and
/// no custom row may claim the reserved `"none"` sentinel id.
fn validate_row_identity(
    namespace: &str,
    id: &str,
    item: &ItemTable,
    is_factory: bool,
) -> Result<(), String> {
    if is_factory {
        if item.name.is_some() {
            return Err(format!(
                "[{namespace}.{id}]: factory items cannot be renamed"
            ));
        }
    } else {
        reject_reserved_id(namespace, id)?;
        if item.name.is_none() {
            return Err(format!(
                "[{namespace}.{id}]: missing `name` (custom rows carry their display name)"
            ));
        }
    }
    Ok(())
}

/// Resolves the user overlay over the factory defaults into a
/// [`State`]: per item (profile or EQ preset), `baseline` = factory ⊕
/// config-shared and `content` = baseline ⊕ config-item — complete at
/// load, so a switch pushes one atomic batch with no per-param
/// fallback. A profile's `selected_eq_preset` resolves like any
/// content key: the row's statement shadows what resolves beneath
/// (key absent = inherit, `"none"` = no-preset, an id = select). Rows
/// `defaults.toml` doesn't ship are custom items, appended after the
/// factory ones over the custom baseline.
///
/// # Panics
///
/// Never in practice: [`parse_config`] requires every custom row to
/// carry its `name`.
#[must_use]
pub fn resolve(defaults: &Defaults, overlay: &ConfigOverlay) -> State {
    let mut state = State::new_from_defaults(defaults);
    state.power = overlay.power.unwrap_or(defaults.power);
    if let Some(selected) = &overlay.selected_profile {
        state.selected_profile = selected.clone();
    }
    overlay_params(
        &mut state.custom_profile_baseline.params,
        &overlay.profile.shared,
    );
    overlay_params(
        &mut state.custom_eq_preset_baseline.params,
        &overlay.eq_preset.shared,
    );
    for profile in &mut state.profiles {
        overlay_params(&mut profile.baseline.params, &overlay.profile.shared);
        profile.content = profile.baseline.clone();
        if let Some(item) = overlay.profile.items.get(&profile.id.0) {
            overlay_params(&mut profile.content.params, &item.params);
            if let Some(stated) = &item.selected_eq_preset {
                profile.content.selected_eq_preset = stated.clone();
            }
        }
    }
    for preset in &mut state.eq_presets {
        overlay_params(&mut preset.baseline.params, &overlay.eq_preset.shared);
        preset.content = preset.baseline.clone();
        if let Some(item) = overlay.eq_preset.items.get(&preset.id.0) {
            overlay_params(&mut preset.content.params, &item.params);
        }
    }
    // Custom items — the rows defaults.toml doesn't ship — append after
    // the factory ones in row order, each resolving over the custom
    // baseline; `is_factory` is derived right here, never stored.
    for (id, item) in &overlay.profile.items {
        if defaults.profiles.iter().any(|profile| profile.id.0 == *id) {
            continue;
        }
        let mut content = state.custom_profile_baseline.clone();
        overlay_params(&mut content.params, &item.params);
        // Absent and the `"none"` sentinel both resolve `None` —
        // customs have nothing beneath to inherit.
        content.selected_eq_preset = item.selected_eq_preset.clone().flatten();
        state.profiles.push(Profile {
            id: ProfileId(id.clone()),
            name: item
                .name
                .clone()
                .expect("parse_config requires custom names"),
            is_factory: false,
            content,
            baseline: state.custom_profile_baseline.clone(),
        });
    }
    for (id, item) in &overlay.eq_preset.items {
        if defaults.eq_presets.iter().any(|preset| preset.id.0 == *id) {
            continue;
        }
        let mut content = state.custom_eq_preset_baseline.clone();
        overlay_params(&mut content.params, &item.params);
        state.eq_presets.push(EqPreset {
            id: PresetId(id.clone()),
            name: item
                .name
                .clone()
                .expect("parse_config requires custom names"),
            is_factory: false,
            content,
            baseline: state.custom_eq_preset_baseline.clone(),
        });
    }
    state
}

/// Serializes the divergence of `state` from the factory truth — the
/// exact bytes `config.toml` should hold. Root keys, `[profile.<id>]`
/// and `[eq_preset.<id>]` tables carry only divergences (the write
/// law, per-item; a profile's EQ selection is a content key like any
/// other — stored iff it diverges from the EQ selection beneath); the
/// shared layers re-emit from `loaded` verbatim. No divergence and no
/// hand-edits ⇒ the empty string (a 0-byte file).
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
        // A custom row always carries its display name (ADR-0007) — so
        // the row exists even with zero divergences; factory names are
        // fixed and never stored.
        if !profile.is_factory {
            emit_value(&mut item, "name", &toml_string(&profile.name));
        }
        if profile.content.selected_eq_preset != profile.baseline.selected_eq_preset {
            // TOML has no null: a diverging no-preset — `None` over an
            // EQ selection resolving beneath — is the reserved `"none"`
            // sentinel (ADR-0007).
            let stated = profile
                .content
                .selected_eq_preset
                .as_ref()
                .map_or("none", |preset| preset.0.as_str());
            emit_value(&mut item, "selected_eq_preset", &toml_string(stated));
        }
        emit_param_divergences(
            &mut item,
            &profile.content.params,
            &profile.baseline.params,
            defs,
        );
        if !item.is_empty() {
            let _ = write!(doc, "\n[profile.{}]\n{item}", profile.id.0);
        }
    }

    emit_shared(&mut doc, "eq_preset", &loaded.eq_preset.shared);
    for preset in &state.eq_presets {
        let mut item = String::new();
        if !preset.is_factory {
            emit_value(&mut item, "name", &toml_string(&preset.name));
        }
        emit_param_divergences(
            &mut item,
            &preset.content.params,
            &preset.baseline.params,
            defs,
        );
        if !item.is_empty() {
            let _ = write!(doc, "\n[eq_preset.{}]\n{item}", preset.id.0);
        }
    }

    // A document that opens with a table header needs no separator.
    match doc.strip_prefix('\n') {
        Some(stripped) => stripped.to_string(),
        None => doc,
    }
}

/// Emits `params`'s divergences from `baseline`, in table order.
fn emit_param_divergences(
    item: &mut String,
    params: &HashMap<String, Vec<i16>>,
    baseline: &HashMap<String, Vec<i16>>,
    defs: &[ParameterDef],
) {
    for def in defs {
        let Some(values) = params.get(&def.name) else {
            continue;
        };
        if *values != baseline[&def.name] {
            emit_value(item, &def.name, &toml_values(values));
        }
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

fn toml_array(values: &[i16]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// A stored param as TOML: single values as bare scalars, band arrays
/// as arrays.
fn toml_values(values: &[i16]) -> String {
    match values {
        [value] => value.to_string(),
        values => toml_array(values),
    }
}

/// A loaded param re-emitted in its declared form.
fn toml_param(value: &ParamValue) -> String {
    match value {
        ParamValue::One(value) => value.to_string(),
        ParamValue::Many(values) => toml_array(values),
    }
}

#[cfg(test)]
mod tests {
    use ddp_state::{Command, ParamAccess, ParamCategory, ParamKind};

    use super::*;

    /// A compact table: a leveler scalar, the preset-carried GEQ grid +
    /// IEQ targets (allocation 4), an experimental scalar, a read-only.
    fn defs() -> Vec<ParameterDef> {
        let def =
            |name: &str, length: usize, min: i16, max: i16, default: Vec<i16>, category, access| {
                ParameterDef {
                    name: name.into(),
                    length,
                    min,
                    max,
                    frac_bits: 0,
                    default,
                    kind: ParamKind::Integer,
                    category,
                    access,
                    label: name.to_uppercase(),
                    description: String::new(),
                    help: String::new(),
                }
            };
        vec![
            def(
                "dvla",
                1,
                0,
                10,
                vec![7],
                ParamCategory::VolumeLeveller,
                ParamAccess::Settable,
            ),
            def(
                "iebt",
                4,
                -480,
                480,
                vec![0; 4],
                ParamCategory::Ieq,
                ParamAccess::Settable,
            ),
            def(
                "gebf",
                4,
                20,
                20000,
                vec![32, 64, 20, 20],
                ParamCategory::Geq,
                ParamAccess::Settable,
            ),
            def(
                "ven",
                1,
                0,
                1,
                vec![0],
                ParamCategory::Visualizer,
                ParamAccess::Experimental,
            ),
            def(
                "vnnb",
                1,
                1,
                20,
                vec![20],
                ParamCategory::Visualizer,
                ParamAccess::ReadOnlyStatic,
            ),
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

[eq_preset]
gebf = [43, 129, 215]

[eq_preset.open]
name = "Open"
iebt = [117, 133]

[eq_preset.rich]
name = "Rich"
iebt = [67, 95]
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
        assert_eq!(
            movie.content.params["ven"],
            vec![1],
            "shared applies to movie"
        );
        assert_eq!(
            music.content.params["ven"],
            vec![1],
            "shared applies to music"
        );
        assert_eq!(
            movie.content.params["dvla"],
            vec![7],
            "movie runs the base default"
        );
        assert_eq!(
            music.content.params["dvla"],
            vec![4],
            "music runs its override"
        );
        assert_eq!(
            music.content.params["gebf"],
            vec![43, 129, 215, 20],
            "a 3-value grid overlays the head; the tail keeps the base"
        );
        assert!(
            !movie.content.params.contains_key("vnnb"),
            "read-only params never enter a profile"
        );
        assert_eq!(music.baseline, music.content, "no user layers yet");
        assert!(
            defaults
                .profiles
                .iter()
                .all(|profile| profile.content.selected_eq_preset.is_none()),
            "behavior 7 (issue #23): the factory EQ selection ships None"
        );
    }

    /// Behavior 1 (issue #23): factory EQ presets load, each resolving
    /// standalone — the `[eq_preset]` shared band structure plus its own
    /// row cover the full preset-carried set, nothing else.
    #[test]
    fn parses_defaults_with_eq_presets_resolving_standalone() {
        let defaults = defaults();
        let ids: Vec<&str> = defaults
            .eq_presets
            .iter()
            .map(|preset| preset.id.0.as_str())
            .collect();
        assert_eq!(ids, ["open", "rich"], "declaration order");

        let rich = &defaults.eq_presets[1];
        assert_eq!(rich.name, "Rich");
        assert!(rich.is_factory);
        assert_eq!(
            rich.content.params["gebf"],
            vec![43, 129, 215, 20],
            "the shared band structure applies to every preset"
        );
        assert_eq!(
            rich.content.params["iebt"],
            vec![67, 95, 0, 0],
            "its own curve"
        );
        assert_eq!(rich.baseline, rich.content, "no user layers yet");
        let mut keys: Vec<&str> = rich.content.params.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["gebf", "iebt"],
            "exactly the preset-carried params — the fixture's {{Ieq, Geq}} set"
        );
        assert_eq!(
            defaults.eq_presets[0].content.params["iebt"],
            vec![117, 133, 0, 0],
            "open resolves its own curve"
        );
    }

    /// Behavior 4 (issue #26 B), schema half: a `defaults.toml`
    /// profile row MAY ship a `selected_eq_preset` naming a
    /// `defaults.toml` preset — loading as both the resolved EQ selection
    /// and its baseline (reset's floor); rows without one
    /// keep shipping `None`.
    #[test]
    fn defaults_rows_may_ship_a_factory_eq_selection() {
        let document = DEFAULTS.replace("dvla = 4", "dvla = 4\nselected_eq_preset = \"open\"");
        let defaults = parse_defaults(&document, &defs()).unwrap();
        let open = Some(PresetId("open".into()));
        let music = &defaults.profiles[1];
        assert_eq!(
            music.content.selected_eq_preset, open,
            "the shipped EQ selection"
        );
        assert_eq!(
            music.baseline.selected_eq_preset, open,
            "…is the reset floor"
        );
        assert_eq!(defaults.profiles[0].content.selected_eq_preset, None);
        assert_eq!(defaults.profiles[0].baseline.selected_eq_preset, None);
    }

    /// Behavior 4 (issue #26 B), sentinel half: over a factory
    /// selection a detach diverges — persisting as the reserved
    /// `"none"` sentinel, reloading as an explicit no-preset — a
    /// whole-item reset falls the EQ selection back to the shipped
    /// preset (row gone, the write law), and a config row may shadow
    /// with another id.
    #[test]
    fn a_diverging_no_preset_round_trips_as_the_none_sentinel() {
        let defs = defs();
        let document = DEFAULTS.replace("dvla = 4", "dvla = 4\nselected_eq_preset = \"open\"");
        let defaults = parse_defaults(&document, &defs).unwrap();
        let loaded = ConfigOverlay::default();
        let mut state = resolve(&defaults, &loaded);
        let music = ProfileId("music".into());

        let _ = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: music.clone(),
                    params: HashMap::new(),
                    selected_eq_preset: Some(None),
                },
                &defs,
            )
            .unwrap();
        let written = serialize_overlay(&state, &defaults, &loaded, &defs);
        assert_eq!(
            written, "[profile.music]\nselected_eq_preset = \"none\"\n",
            "None over an EQ selection beneath diverges ⇒ the sentinel"
        );
        let reloaded = resolve(
            &defaults,
            &parse_config(&written, &defs, &defaults).unwrap(),
        );
        assert_eq!(
            reloaded, state,
            "the sentinel reloads as an explicit no-preset, not re-inheriting open"
        );

        let _ = state
            .apply(
                Command::ResetProfile {
                    id: music,
                    only: None,
                },
                &defs,
            )
            .unwrap();
        assert_eq!(
            state.selected().content.selected_eq_preset,
            Some(PresetId("open".into())),
            "reset falls the EQ selection back to the shipped factory preset"
        );
        assert_eq!(serialize_overlay(&state, &defaults, &loaded, &defs), "");

        // A config row shadows the factory EQ selection like any layer.
        let overlay = parse_config(
            "[profile.music]\nselected_eq_preset = \"rich\"\n",
            &defs,
            &defaults,
        )
        .unwrap();
        let state = resolve(&defaults, &overlay);
        assert_eq!(
            state.selected().content.selected_eq_preset,
            Some(PresetId("rich".into()))
        );
        assert_eq!(
            state.selected().baseline.selected_eq_preset,
            Some(PresetId("open".into())),
            "the baseline stays the defaults row's"
        );
    }

    #[test]
    fn rejects_malformed_or_invalid_defaults() {
        let cases = [
            ("power = true\n".to_string(), "selected_profile"),
            ("power = tru".to_string(), "expected"),
            (DEFAULTS.replace("power = true", "power = true\nx = 1"), "x"),
            (DEFAULTS.replace("dvla = 4", "dvla = 11"), "outside"),
            (DEFAULTS.replace("dvla = 4", "vnnb = 5"), "read-only"),
            (
                DEFAULTS.replace("dvla = 4", "mxou = 1"),
                "unknown parameter",
            ),
            (DEFAULTS.replace("dvla = 4", "dvla = 40000"), "i16"),
            (DEFAULTS.replace("name = \"Movie\"\n", ""), "name"),
            (
                DEFAULTS.replace("selected_profile = \"music\"", "selected_profile = \"x\""),
                "names no profile",
            ),
            (
                DEFAULTS.replace("name = \"Open\"\n", ""),
                "[eq_preset.open]: missing `name`",
            ),
            (
                DEFAULTS.replace("iebt = [67, 95]", "dvla = 5"),
                "not preset-carried",
            ),
            (
                DEFAULTS.replace("dvla = 4", "selected_eq_preset = \"ghost\""),
                "names no EQ preset",
            ),
            // Behavior 4 (issue #26 B): the sentinel encodes a
            // *diverging* no-preset — meaningless in defaults.toml,
            // where nothing resolves beneath.
            (
                DEFAULTS.replace("dvla = 4", "selected_eq_preset = \"none\""),
                "must name a defaults.toml preset",
            ),
            (
                format!("{DEFAULTS}\n[profile.none]\nname = \"X\"\n"),
                "reserved",
            ),
            (
                format!("{DEFAULTS}\n[eq_preset.none]\nname = \"X\"\n"),
                "reserved",
            ),
            (
                DEFAULTS.replace("iebt = [67, 95]", "selected_eq_preset = \"open\""),
                "applies to profiles",
            ),
            (
                DEFAULTS.replace("dvla = 4", "selected_eq_preset = 5"),
                "preset id string",
            ),
        ];
        for (document, needle) in &cases {
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
            // A non-factory row is a custom item — its name is required
            // (also the guard against typo'd factory ids).
            ("[profile.gost]\ndvla = 1\n", "missing `name`"),
            ("[profile.music]\nname = \"Loud\"\n", "renamed"),
            ("[profile.music]\ndvla = 99\n", "outside"),
            ("[profile]\nvnnb = 5\n", "read-only"),
            ("[eq_preset.rich]\niebt = [999]\n", "outside"),
            ("[eq_preset.ghost]\niebt = [1]\n", "missing `name`"),
            ("[eq_preset.rich]\nname = \"Loud\"\n", "renamed"),
            // The explicit no-preset sentinel is not an id any item may
            // claim — a `[eq_preset.none]` row would make every
            // `selected_eq_preset = "none"` ambiguous.
            ("[eq_preset.none]\nname = \"X\"\n", "reserved"),
            ("[profile.none]\nname = \"X\"\n", "reserved"),
            (
                "[profile.user_a1]\nname = \"X\"\nselected_eq_preset = \"ghost\"\n",
                "names no EQ preset",
            ),
            ("[eq_preset.rich]\ndvla = 5\n", "not preset-carried"),
            ("[eq_preset]\nven = 1\n", "not preset-carried"),
            (
                "[eq_preset.rich]\nselected_eq_preset = \"open\"\n",
                "applies to profiles",
            ),
            (
                "[profile.music]\nselected_eq_preset = \"ghost\"\n",
                "names no EQ preset",
            ),
            (
                "[profile.music]\nselected_eq_preset = 5\n",
                "preset id string",
            ),
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
            assert_eq!(
                state.selected().content.params["dvla"],
                expected,
                "layer: {layer}"
            );
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
        assert_eq!(state.selected().content.params["dvla"], vec![2]);
        assert_eq!(state.selected().baseline.params["dvla"], vec![3]);

        let _ = state
            .apply(
                Command::ResetProfile {
                    id: ProfileId("music".into()),
                    only: None,
                },
                &defs,
            )
            .unwrap();
        assert_eq!(
            state.selected().content.params["dvla"],
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
                    name: None,
                    id: ProfileId("music".into()),
                    params: [("dvla".to_string(), vec![5_i16])].into(),
                    selected_eq_preset: None,
                },
                &defs,
            )
            .unwrap();
        let _ = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: ProfileId("movie".into()),
                    params: [("gebf".to_string(), vec![99_i16, 64])].into(),
                    selected_eq_preset: None,
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

    /// Hand-edited shared layers survive a write-back verbatim — the
    /// daemon writes per-item only; a hand-edited `[eq_preset.<id>]`
    /// row re-emits as a normal per-item divergence.
    #[test]
    fn write_back_preserves_hand_edited_shared_layers() {
        let defs = defs();
        let defaults = defaults();
        let hand_edited = "\
[profile]
dvla = 3
gebf = [50, 60]

[eq_preset]
gebf = [70, 80]

[eq_preset.rich]
iebt = [44, 55]
";
        let loaded = parse_config(hand_edited, &defs, &defaults).unwrap();
        let mut state = resolve(&defaults, &loaded);
        let _ = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: [("dvla".to_string(), vec![9_i16])].into(),
                    selected_eq_preset: None,
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
gebf = [70, 80]

[eq_preset.rich]
iebt = [44, 55, 0, 0]
",
        );
        // And the preserved document reloads to the same state.
        let reloaded = parse_config(&written, &defs, &defaults).unwrap();
        assert_eq!(reloaded.profile.shared, loaded.profile.shared);
        assert_eq!(reloaded.eq_preset.shared, loaded.eq_preset.shared);
        assert_eq!(resolve(&defaults, &reloaded), state);
    }

    /// Behaviors 1 + 7 (issue #26 A), schema half: custom rows —
    /// `name` in the row, id as the key — parse, resolve over the
    /// custom baseline (config-shared included), may select custom
    /// presets and be the `selected_profile`, and round-trip through
    /// `serialize_overlay` byte for byte.
    #[test]
    fn custom_rows_resolve_over_the_custom_baseline_and_round_trip() {
        let defs = defs();
        let defaults = defaults();
        let document = "\
selected_profile = \"user_a3f1\"

[profile]
dvla = 3

[profile.user_a3f1]
name = \"Late Night\"
selected_eq_preset = \"user_91c2\"
dvla = 2

[eq_preset.user_91c2]
name = \"Warmth\"
iebt = [44, 55, 0, 0]
";
        let overlay = parse_config(document, &defs, &defaults).unwrap();
        let state = resolve(&defaults, &overlay);

        assert_eq!(state.selected_profile, ProfileId("user_a3f1".into()));
        let custom = state.selected();
        assert!(!custom.is_factory, "derived from defaults.toml absence");
        assert_eq!(custom.name, "Late Night");
        assert_eq!(custom.content.params["dvla"], vec![2], "its own row");
        assert_eq!(
            custom.baseline.params["dvla"],
            vec![3],
            "the custom baseline carries config-shared"
        );
        assert_eq!(
            custom.content.params["ven"],
            vec![1],
            "…and the defaults [profile] shared layer"
        );
        assert_eq!(
            custom.content.selected_eq_preset,
            Some(PresetId("user_91c2".into())),
            "customs may select custom presets"
        );
        let warmth = state.eq_preset(&PresetId("user_91c2".into())).unwrap();
        assert!(!warmth.is_factory);
        assert_eq!(warmth.content.params["iebt"], vec![44, 55, 0, 0]);
        assert_eq!(
            warmth.content.params["gebf"],
            vec![43, 129, 215, 20],
            "the [eq_preset] shared band structure applies to customs"
        );

        assert_eq!(
            serialize_overlay(&state, &defaults, &overlay, &defs),
            document,
            "the loaded document re-emits byte for byte (band arrays at \
             full allocation, as write-back always emits them)"
        );
    }

    /// The `[eq_preset]` cascade mirrors the profile one: config-shared
    /// shadows factory for every preset, the item shadows shared, and
    /// the baseline sits beneath the item layer (reset lands there).
    #[test]
    fn the_eq_preset_cascade_resolves_config_layers_over_factory() {
        let defs = defs();
        let defaults = defaults();
        let overlay = parse_config(
            "[eq_preset]\niebt = [1, 2]\n\n[eq_preset.rich]\niebt = [9]\n",
            &defs,
            &defaults,
        )
        .unwrap();
        let state = resolve(&defaults, &overlay);
        let rich = state.eq_preset(&PresetId("rich".into())).unwrap();
        assert_eq!(rich.content.params["iebt"], vec![9, 2, 0, 0]);
        assert_eq!(rich.baseline.params["iebt"], vec![1, 2, 0, 0]);
        let open = state.eq_preset(&PresetId("open".into())).unwrap();
        assert_eq!(
            open.content.params["iebt"],
            vec![1, 2, 0, 0],
            "config-shared applies to every preset"
        );
    }

    /// Behavior 6 (issue #23), serialization half: a profile's
    /// EQ selection persists as `selected_eq_preset` in its item (present
    /// ⟺ `Some` — a custom's EQ selection baseline is always `None`), preset edits as
    /// `[eq_preset.<id>]` divergences; both round-trip.
    #[test]
    fn eq_selection_and_preset_edits_serialize_and_round_trip() {
        let defs = defs();
        let defaults = defaults();
        let loaded = ConfigOverlay::default();
        let mut state = resolve(&defaults, &loaded);

        let _ = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: HashMap::new(),
                    selected_eq_preset: Some(Some(PresetId("rich".into()))),
                },
                &defs,
            )
            .unwrap();
        let _ = state
            .apply(
                Command::EditEqPreset {
                    name: None,
                    id: PresetId("rich".into()),
                    params: [("iebt".to_string(), vec![100_i16])].into(),
                },
                &defs,
            )
            .unwrap();

        let document = serialize_overlay(&state, &defaults, &loaded, &defs);
        assert_eq!(
            document,
            "[profile.music]\nselected_eq_preset = \"rich\"\n\n[eq_preset.rich]\niebt = [100, 95, 0, 0]\n"
        );
        let reloaded = resolve(
            &defaults,
            &parse_config(&document, &defs, &defaults).unwrap(),
        );
        assert_eq!(reloaded, state);

        // Detach + reset ⇒ no divergence left ⇒ an empty file again
        // (the write law: `None` over nothing-beneath stores no key).
        let _ = state
            .apply(
                Command::EditProfile {
                    name: None,
                    id: ProfileId("music".into()),
                    params: HashMap::new(),
                    selected_eq_preset: Some(None),
                },
                &defs,
            )
            .unwrap();
        let _ = state
            .apply(
                Command::ResetEqPreset {
                    id: PresetId("rich".into()),
                    only: None,
                },
                &defs,
            )
            .unwrap();
        assert_eq!(serialize_overlay(&state, &defaults, &loaded, &defs), "");
    }
}
