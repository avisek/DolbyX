//! Acceptance tests for the shipped `defaults.toml` (Slice 10,
//! [#18](https://github.com/avisek/DolbyX/issues/18)): the four factory
//! profiles resolve to the original DDP module's values
//! (`vendored/ds1-default.xml` via `docs/ddp/05`).

use ddp_state::{ParameterDef, Profile, State};

const PARAMETERS: &str = include_str!("../parameters.toml");
const DEFAULTS: &str = include_str!("../defaults.toml");

/// The original 20-band grid — GEQ, IEQ, and visualizer band centres.
const DDP_GRID: [i16; 20] = [
    43, 129, 215, 301, 431, 603, 775, 947, 1206, 1550, 2067, 2756, 3618, 4651, 5685, 7063, 8958,
    11025, 13781, 18777,
];

fn defs() -> Vec<ParameterDef> {
    ddp_state::parse(PARAMETERS).expect("parameters.toml must parse")
}

fn defaults() -> ddp_state::Defaults {
    ddp_persistence::parse_defaults(DEFAULTS, &defs()).expect("defaults.toml must parse")
}

fn scalar(profile: &Profile, name: &str) -> i16 {
    profile.params[name][0]
}

/// Behavior 1 (issue #18): four factory profiles with their declared
/// overrides, in the original's order.
#[test]
fn ships_the_four_factory_profiles() {
    let defaults = defaults();
    assert!(defaults.power);
    assert_eq!(defaults.selected_profile.0, "music");
    let names: Vec<(&str, &str)> = defaults
        .profiles
        .iter()
        .map(|profile| (profile.id.0.as_str(), profile.name.as_str()))
        .collect();
    assert_eq!(
        names,
        [
            ("movie", "Movie"),
            ("music", "Music"),
            ("game", "Game"),
            ("voice", "Voice"),
        ],
    );
    assert!(defaults.profiles.iter().all(|profile| profile.is_factory));
    assert!(
        defaults
            .profiles
            .iter()
            .all(|profile| profile.selected_eq_preset.is_none()),
        "factory EQ preset selection ships None (Slice 15 wires presets)"
    );
}

/// Behavior 1 (issue #18): shared `[profile]` keys apply to every
/// profile — the standard 20-band stereo config stated once.
#[test]
fn the_shared_block_applies_to_every_profile() {
    let defaults = defaults();
    for profile in &defaults.profiles {
        let id = &profile.id.0;
        assert_eq!(scalar(profile, "genb"), 20, "{id}: genb");
        assert_eq!(scalar(profile, "ienb"), 20, "{id}: ienb");
        assert_eq!(scalar(profile, "aonb"), 20, "{id}: aonb");
        assert_eq!(scalar(profile, "arnb"), 20, "{id}: arnb");
        assert_eq!(scalar(profile, "aocc"), 2, "{id}: aocc");
        assert_eq!(profile.params["gebf"][..20], DDP_GRID, "{id}: gebf");
        assert_eq!(profile.params["iebf"][..20], DDP_GRID, "{id}: iebf");
        assert_eq!(scalar(profile, "dvli"), -320, "{id}: dvli");
        assert_eq!(scalar(profile, "dvlo"), -320, "{id}: dvlo");
        // The speaker tuning tables ride along, dormant at the pinned
        // headphone endpoint.
        assert_eq!(scalar(profile, "artp"), 12, "{id}: artp");
        assert_eq!(profile.params["arbi"][..4], [1, 1, 1, 1], "{id}: arbi");
        assert_eq!(profile.params["aobg"][0], 2, "{id}: aobg channel id");
        // v2 pins: the original's GENERIC → DEVICE_WIRED_HEADPHONE
        // endpoint, and the visualizer feed.
        assert_eq!(scalar(profile, "endp"), 1, "{id}: endp");
        assert_eq!(scalar(profile, "ven"), 1, "{id}: ven");
        // Band arrays stay allocated at engine capacity.
        assert_eq!(profile.params["gebf"].len(), 40, "{id}: gebf allocation");
        assert_eq!(profile.params["aobg"].len(), 329, "{id}: aobg allocation");
    }
}

/// The per-profile character values, straight from the XML profiles —
/// out of the box, Music + power on is the original module's sound.
#[test]
fn profiles_resolve_the_original_module_values() {
    let defaults = defaults();
    let state = State::new_from_defaults(&defaults);
    // (profile, dvla, dvle, deon, dea, dhsb, dssb, vdhe, vspe, vmon, aoon)
    let expected: [(&str, [i16; 10]); 4] = [
        ("movie", [7, 0, 1, 3, 96, 96, 2, 0, 0, 2]),
        ("music", [4, 0, 1, 2, 48, 0, 2, 0, 0, 2]),
        ("game", [0, 1, 0, 7, 0, 0, 2, 2, 2, 2]),
        ("voice", [0, 0, 1, 10, 0, 0, 0, 0, 0, 2]),
    ];
    for (id, [dvla, dvle, deon, dea, dhsb, dssb, vdhe, vspe, vmon, aoon]) in expected {
        let profile = state
            .profile(&ddp_state::ProfileId(id.into()))
            .expect("factory profile");
        assert_eq!(scalar(profile, "dvla"), dvla, "{id}: dvla");
        assert_eq!(scalar(profile, "dvle"), dvle, "{id}: dvle");
        assert_eq!(scalar(profile, "deon"), deon, "{id}: deon");
        assert_eq!(scalar(profile, "dea"), dea, "{id}: dea");
        assert_eq!(scalar(profile, "dhsb"), dhsb, "{id}: dhsb");
        assert_eq!(scalar(profile, "dssb"), dssb, "{id}: dssb");
        assert_eq!(scalar(profile, "vdhe"), vdhe, "{id}: vdhe");
        assert_eq!(scalar(profile, "vspe"), vspe, "{id}: vspe");
        assert_eq!(scalar(profile, "vmon"), vmon, "{id}: vmon");
        assert_eq!(scalar(profile, "aoon"), aoon, "{id}: aoon");
        // Shared across every XML profile: virtualizer start frequency,
        // IEQ off with amount staged, GEQ off, limiter auto.
        assert_eq!(scalar(profile, "dssf"), 200, "{id}: dssf");
        assert_eq!(scalar(profile, "ieon"), 0, "{id}: ieon");
        assert_eq!(scalar(profile, "iea"), 10, "{id}: iea");
        assert_eq!(scalar(profile, "geon"), 0, "{id}: geon");
        assert_eq!(scalar(profile, "plmd"), 4, "{id}: plmd");
        assert_eq!(scalar(profile, "vmb"), 144, "{id}: vmb");
        assert_eq!(scalar(profile, "ngon"), 2, "{id}: ngon");
    }
}

/// Every profile is complete: exactly the 52 writable params, resolved
/// — a switch pushes the whole set with no per-param fallback.
#[test]
fn profiles_carry_exactly_the_writable_params() {
    let defs = defs();
    let writable = defs.iter().filter(|def| def.access.is_writable()).count();
    assert_eq!(writable, 52);
    for profile in defaults().profiles {
        assert_eq!(profile.params.len(), 52, "{}", profile.id.0);
        for def in defs.iter().filter(|def| def.access.is_writable()) {
            let values = profile.params.get(&def.name).expect("complete");
            assert_eq!(values.len(), def.length, "{}: {}", profile.id.0, def.name);
        }
    }
}
