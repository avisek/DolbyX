//! Acceptance tests for the shipped `defaults.toml` (Slices 10
//! [#18](https://github.com/avisek/DolbyX/issues/18) and 15
//! [#23](https://github.com/avisek/DolbyX/issues/23)): the four factory
//! profiles and three factory EQ presets resolve to the original DDP
//! module's values (`vendored/ds1-default.xml` via `docs/ddp/05`).

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
    profile.content.params[name][0]
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
            .all(|profile| profile.content.selected_eq_preset.is_none()),
        "behavior 7 (issue #23): the factory EQ selection ships None — the \
         original ships ieon = 0 on every profile"
    );
}

/// Behavior 1 (issue #23): the three factory EQ presets ship the XML's
/// IEQ target curves, each resolving standalone — the `[eq_preset]`
/// shared band structure completes the full nine preset-carried params.
#[test]
fn ships_the_three_factory_eq_presets_resolving_standalone() {
    let defs = defs();
    let defaults = defaults();
    let names: Vec<(&str, &str)> = defaults
        .eq_presets
        .iter()
        .map(|preset| (preset.id.0.as_str(), preset.name.as_str()))
        .collect();
    assert_eq!(
        names,
        [("open", "Open"), ("rich", "Rich"), ("focused", "Focused")],
    );

    let eq_params: Vec<&str> = defs
        .iter()
        .filter(|def| def.access.is_writable() && def.category.is_preset_carried())
        .map(|def| def.name.as_str())
        .collect();
    assert_eq!(
        eq_params,
        [
            "ienb", "iebf", "iebt", "ieon", "iea", "geon", "genb", "gebf", "gebg"
        ],
        "the table derives exactly the nine EQ params"
    );

    for preset in &defaults.eq_presets {
        let id = &preset.id.0;
        assert!(preset.is_factory, "{id}");
        assert_eq!(preset.content.params.len(), 9, "{id}: exactly the nine");
        assert_eq!(preset.content.params["genb"][0], 20, "{id}: genb");
        assert_eq!(preset.content.params["ienb"][0], 20, "{id}: ienb");
        assert_eq!(preset.content.params["gebf"][..20], DDP_GRID, "{id}: gebf");
        assert_eq!(preset.content.params["iebf"][..20], DDP_GRID, "{id}: iebf");
        assert_eq!(preset.content.params["ieon"][0], 1, "{id}: ieon staged on");
        assert_eq!(preset.content.params["iea"][0], 10, "{id}: iea");
        assert_eq!(preset.content.params["geon"][0], 0, "{id}: GEQ off");
        assert_eq!(preset.content.params["gebg"], vec![0; 40], "{id}: flat GEQ");
        assert_eq!(
            preset.content.params["iebt"].len(),
            40,
            "{id}: iebt allocation"
        );
        assert_eq!(preset.baseline, preset.content, "{id}: no user layers");
    }

    // The three IEQ target curves, verbatim from the XML (docs/ddp/05).
    let curves: [(&str, [i16; 20]); 3] = [
        (
            "open",
            [
                117, 133, 188, 176, 141, 149, 175, 185, 185, 200, 236, 242, 228, 213, 182, 132,
                110, 68, -27, -240,
            ],
        ),
        (
            "rich",
            [
                67, 95, 172, 163, 168, 201, 189, 242, 196, 221, 192, 186, 168, 139, 102, 57, 35, 9,
                -55, -235,
            ],
        ),
        (
            "focused",
            [
                -419, -112, 75, 116, 113, 160, 165, 80, 61, 79, 98, 121, 64, 70, 44, -71, -33,
                -100, -238, -411,
            ],
        ),
    ];
    for (id, curve) in curves {
        let preset = defaults
            .eq_presets
            .iter()
            .find(|preset| preset.id.0 == id)
            .expect("factory preset");
        assert_eq!(preset.content.params["iebt"][..20], curve, "{id}: iebt");
    }
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
        assert_eq!(profile.content.params["gebf"][..20], DDP_GRID, "{id}: gebf");
        assert_eq!(profile.content.params["iebf"][..20], DDP_GRID, "{id}: iebf");
        assert_eq!(scalar(profile, "dvli"), -320, "{id}: dvli");
        assert_eq!(scalar(profile, "dvlo"), -320, "{id}: dvlo");
        // The speaker tuning tables ride along, dormant at the pinned
        // headphone endpoint.
        assert_eq!(scalar(profile, "artp"), 12, "{id}: artp");
        assert_eq!(
            profile.content.params["arbi"][..4],
            [1, 1, 1, 1],
            "{id}: arbi"
        );
        assert_eq!(
            profile.content.params["aobg"][0], 2,
            "{id}: aobg channel id"
        );
        // v2 pins: the engine's HEADPHONES endpoint (AK encoding 2 —
        // probe-verified vdhe auto gate, v1's value; docs/ddp/02
        // `endp`), and the visualizer feed.
        assert_eq!(scalar(profile, "endp"), 2, "{id}: endp");
        assert_eq!(scalar(profile, "ven"), 1, "{id}: ven");
        // Behavior 5 (issue #24): the custom-grid enabler — power-on
        // vcnb = 0 reads the custom pair zero forever; the defaults
        // put it on the DDP grid (the only guard on the exact
        // frequencies — the qemu suite proves nonzero only).
        assert_eq!(scalar(profile, "vcnb"), 20, "{id}: vcnb");
        assert_eq!(profile.content.params["vcbf"], DDP_GRID, "{id}: vcbf");
        // Band arrays stay allocated at engine capacity.
        assert_eq!(
            profile.content.params["gebf"].len(),
            40,
            "{id}: gebf allocation"
        );
        assert_eq!(
            profile.content.params["aobg"].len(),
            329,
            "{id}: aobg allocation"
        );
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
        assert_eq!(profile.content.params.len(), 52, "{}", profile.id.0);
        for def in defs.iter().filter(|def| def.access.is_writable()) {
            let values = profile.content.params.get(&def.name).expect("complete");
            assert_eq!(values.len(), def.length, "{}: {}", profile.id.0, def.name);
        }
    }
}
