//! Acceptance tests for the shipped `parameters.toml` (Slice 03,
//! [#11](https://github.com/avisek/DolbyX/issues/11)) and the CI structural
//! check against the probe-generated `parameters.engine.toml` twin.

use ddp_state::{
    ParamAccess, ParamCategory, ParamKind, ParameterDef, ParameterTable, lookup, parse,
};

const PARAMETERS: &str = include_str!("../parameters.toml");
const TWIN: &str = include_str!("../parameters.engine.toml");

fn table() -> ParameterTable {
    parse(PARAMETERS).expect("parameters.toml must parse")
}

fn defs() -> Vec<ParameterDef> {
    table().params
}

/// Tracer bullet: the table holds exactly the engine's 64 root leaves —
/// `scpe`/`test` in, Java's phantoms `mxou`/`lcsz` out.
#[test]
fn parses_the_64_root_leaves() {
    let defs = defs();
    assert_eq!(defs.len(), 64);
    assert!(lookup(&defs, "scpe").is_some());
    assert!(lookup(&defs, "test").is_some());
    assert!(lookup(&defs, "mxou").is_none(), "mxou is a dead phantom");
    assert!(lookup(&defs, "lcsz").is_none(), "lcsz is a dead phantom");
}

#[test]
fn spot_checks_dvla_and_scpe() {
    let defs = defs();
    let dvla = lookup(&defs, "dvla").unwrap();
    assert_eq!((dvla.min, dvla.max), (0, 10));
    assert_eq!(dvla.frac_bits, 0);
    assert_eq!(dvla.access, ParamAccess::Settable);
    assert_eq!(
        lookup(&defs, "scpe").unwrap().access,
        ParamAccess::Experimental
    );
    let category_of = |name| lookup(&defs, name).unwrap().category;
    assert_eq!(category_of("bndl"), ParamCategory::Build);
    assert_eq!(category_of("lcmf"), ParamCategory::License);
    assert_eq!(category_of("dvla"), ParamCategory::VolumeLeveller);
}

/// The `[[category]]` table (issue #83): fifteen Parameter categories in
/// the prototype's section order, `build` / `license` split three each,
/// every root leaf listed exactly once.
#[test]
fn ships_fifteen_categories_covering_every_leaf_once() {
    let table = table();
    let labels: Vec<&str> = table.categories.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(
        labels,
        [
            "Volume Leveler",
            "Intelligent Equalizer",
            "Graphic Equalizer",
            "Dialog Enhancer",
            "Volume Maximizer",
            "Speaker Virtualizer",
            "Headphone Virtualizer",
            "Next Gen Surround",
            "Audio Regulator",
            "Audio Optimizer",
            "Peak Limiter",
            "Endpoint Volume",
            "Visualizer",
            "Build",
            "License",
        ]
    );
    let by_name = |name| table.categories.iter().find(|c| c.name == name).unwrap();
    assert_eq!(
        by_name(ParamCategory::Build).params,
        ["bver", "ver", "bndl"]
    );
    assert_eq!(
        by_name(ParamCategory::License).params,
        ["lcmf", "lcvd", "lcpt"]
    );
    // The parser holds exactly-once membership; the shipped table must
    // also reach all 64 leaves.
    let listed: usize = table.categories.iter().map(|c| c.params.len()).sum();
    assert_eq!(listed, 64);
    assert_eq!(table.params.len(), 64);
}

/// The four settability buckets hold exactly 42 / 10 / 4 / 8 params.
#[test]
fn bucket_counts_validate() {
    let defs = defs();
    let count = |access| defs.iter().filter(|d| d.access == access).count();
    assert_eq!(count(ParamAccess::Settable), 42);
    assert_eq!(count(ParamAccess::Experimental), 10);
    assert_eq!(count(ParamAccess::ReadOnlyDynamic), 4);
    assert_eq!(count(ParamAccess::ReadOnlyStatic), 8);
}

/// Every dB-coded param carries `frac_bits = 4`, and the LKFS pair is
/// exactly `dvli`/`dvlo`. (The converse doesn't hold: `iea`/`dea`/`ded`/
/// `artp` are engine fixed-point *amounts* — frac 4, not dB.)
#[test]
fn db_coded_params_carry_frac_bits_4() {
    for def in defs() {
        let db_coded = matches!(
            def.kind,
            ParamKind::Decibel { .. } | ParamKind::AobgChannelMajor
        );
        assert!(
            !db_coded || def.frac_bits == 4,
            "`{}`: dB-coded but frac_bits {}",
            def.name,
            def.frac_bits
        );
        assert_eq!(
            def.kind == ParamKind::Decibel { lkfs: true },
            matches!(def.name.as_str(), "dvli" | "dvlo"),
            "`{}` mislabels LKFS",
            def.name
        );
    }
}

/// The four DSP-owned vis arrays are by-ref slots the engine API carries
/// no metadata for (frac 0, full-int16 bounds); `parameters.toml` records
/// the real coding instead — engine help: "scaled by 16 ie. 16 = 1 dB";
/// in-contract output range [-192, 576] (ddp/02).
#[test]
fn vis_arrays_carry_corrected_db_facts() {
    let defs = defs();
    for name in ["vnbg", "vnbe", "vcbg", "vcbe"] {
        let def = lookup(&defs, name).unwrap();
        assert_eq!(
            def.kind,
            ParamKind::Decibel { lkfs: false },
            "`{name}` kind"
        );
        assert_eq!((def.min, def.max), (-192, 576), "`{name}` bounds");
        assert_eq!(def.frac_bits, 4, "`{name}` frac_bits");
        assert_eq!(def.access, ParamAccess::ReadOnlyDynamic, "`{name}` access");
    }
}

/// The engine boots 10-band — `genb` 10, band-freq actives the ISO octave
/// centres — but its power-on state holds out-of-bounds zeros (param-twin
/// truth). The curated table corrects exactly those slots: inactive band
/// slots clamp to min, `vnnb` curates 20 — the rate-derived native-grid
/// count at 44.1/48 kHz (ADR-0004).
#[test]
fn curated_defaults_correct_the_oob_power_on_slots() {
    let defs = defs();
    assert_eq!(lookup(&defs, "genb").unwrap().default, vec![10]);
    let iso = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    for name in ["iebf", "gebf", "aobf", "arbf"] {
        let def = lookup(&defs, name).unwrap();
        assert_eq!(def.default[..10], iso, "`{name}` active centres");
        assert!(
            def.default[10..].iter().all(|&v| v == def.min),
            "`{name}` tail must clamp to min"
        );
    }
    assert_eq!(lookup(&defs, "vcbf").unwrap().default, vec![20; 20]);
    assert_eq!(lookup(&defs, "vnnb").unwrap().default, vec![20]);
}

/// The CI structural check against the param twin: the same 64 leaves
/// in the same `[[param]]` order (display order lives only in
/// `[[category]]`, so the two files diff line-for-line), `length` equal
/// (the allocation is a hard engine fact), every range within the
/// engine envelope. Everything else — narrowed bounds, `frac_bits`,
/// `default` — is curation, free to diverge; the parser already holds
/// every default slot inside `[min, max]`. Red? Rerun `just param-twin`
/// to see the engine's truth.
#[test]
fn stays_within_the_engine_envelope() {
    let defs = defs();
    let twin: toml::Table = toml::from_str(TWIN).expect("twin must parse");
    let twin = twin["param"].as_array().expect("twin [[param]] array");

    let twin_names: Vec<&str> = twin
        .iter()
        .map(|p| p["name"].as_str().expect("twin name"))
        .collect();
    let names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(
        names, twin_names,
        "[[param]] order must match the param twin"
    );

    for entry in twin {
        let name = entry["name"].as_str().unwrap();
        let def = lookup(&defs, name).unwrap();
        let fact = |key: &str| {
            entry[key]
                .as_integer()
                .unwrap_or_else(|| panic!("twin `{name}`.{key} not an integer"))
        };
        assert_eq!(
            i64::try_from(def.length).unwrap(),
            fact("length"),
            "`{name}` length"
        );
        assert!(
            i64::from(def.min) >= fact("min"),
            "`{name}` min {} below the engine envelope {}",
            def.min,
            fact("min")
        );
        assert!(
            i64::from(def.max) <= fact("max"),
            "`{name}` max {} above the engine envelope {}",
            def.max,
            fact("max")
        );
    }
}
