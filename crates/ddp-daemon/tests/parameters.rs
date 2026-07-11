//! Acceptance tests for the shipped `parameters.toml` (Slice 03,
//! [#11](https://github.com/avisek/DolbyX/issues/11)) and the CI structural
//! check against the probe-generated `parameters.engine.toml` twin.

use ddp_state::{ParamAccess, ParamCategory, ParamKind, ParameterDef, lookup, parse};

const PARAMETERS: &str = include_str!("../parameters.toml");
const TWIN: &str = include_str!("../parameters.engine.toml");

fn defs() -> Vec<ParameterDef> {
    parse(PARAMETERS).expect("parameters.toml must parse")
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
    assert_eq!(
        lookup(&defs, "bndl").unwrap().category,
        ParamCategory::BuildLicense
    );
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
/// centres — but its power-on state holds out-of-bounds zeros (twin
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
            def.default[10..].iter().all(|&v| v == 20),
            "`{name}` tail must clamp to min"
        );
    }
    assert_eq!(lookup(&defs, "vcbf").unwrap().default, vec![20; 20]);
    assert_eq!(lookup(&defs, "vnnb").unwrap().default, vec![20]);
}

/// The CI structural check against the param twin: same 64 leaves,
/// `length` equal (the allocation is a hard engine fact), every range
/// within the engine envelope. Everything else — narrowed bounds,
/// `frac_bits`, `default` — is curation, free to diverge; the parser
/// already holds every default slot inside `[min, max]`. Red? Rerun
/// `just param-twin` to see the engine's truth.
#[test]
fn stays_within_the_engine_envelope() {
    let defs = defs();
    let twin: toml::Table = toml::from_str(TWIN).expect("twin must parse");
    let twin = twin["param"].as_array().expect("twin [[param]] array");

    let twin_names: Vec<&str> = twin
        .iter()
        .map(|p| p["name"].as_str().expect("twin name"))
        .collect();
    let mut names: Vec<&str> = defs.iter().map(|d| d.name.as_str()).collect();
    names.sort_unstable();
    let mut sorted_twin_names = twin_names.clone();
    sorted_twin_names.sort_unstable();
    assert_eq!(names, sorted_twin_names, "parameter sets differ");

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
