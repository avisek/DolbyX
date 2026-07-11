//! Regenerates `parameters.engine.toml` — the probe-generated engine-fact
//! twin of `parameters.toml` — from the `ddp_probe` dumps.
//!
//! Usage: `gen_param_twin <tree> <defaults> <docs> <out>`, where the first
//! three arguments are files holding the output of `make -C tools/ddp_probe
//! dump-tree / dump-defaults / dump-docs`. Run via `just param-twin`.
//!
//! The twin is committed, never loaded — the engine-truth reference
//! `parameters.toml` is curated from. CI checks that table's structure
//! against it: names 1:1, lengths equal, ranges within the engine
//! envelope
//! ([ADR-0004](https://github.com/avisek/DolbyX/blob/main/docs/adr/0004-parameter-metadata-as-single-source-of-truth.md)).

#![forbid(unsafe_code)]

use std::collections::HashMap;
use std::process::ExitCode;

/// One root leaf in the twin — engine facts + the engine's own strings.
#[derive(Debug, serde::Serialize)]
struct TwinParam {
    name: String,
    length: usize,
    min: i16,
    max: i16,
    frac_bits: u8,
    default: Vec<i16>,
    label: String,
    description: String,
    help: String,
}

/// The twin document root, mirroring `parameters.toml`'s `[[param]]` shape.
#[derive(serde::Serialize)]
struct Document {
    param: Vec<TwinParam>,
}

/// Per-leaf metadata scraped from a `dump-tree` detail line.
struct TreeLeaf {
    length: usize,
    min: i16,
    max: i16,
    frac_bits: u8,
}

/// Display name + description + long help scraped from `dump-docs`.
struct DocEntry {
    label: String,
    description: String,
    help: String,
}

const HEADER: &str = "\
# parameters.engine.toml — probe-generated engine-truth twin of
# parameters.toml. DO NOT HAND-EDIT; regenerate with `just param-twin`.
# Never loaded by the daemon: it is the reference parameters.toml is
# curated from — CI checks that table's structure against this one:
# names 1:1, lengths equal, ranges within the engine envelope (ADR-0004).
# label/description/help are the engine's own strings, kept as the
# seeding reference.

";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [tree, defaults, docs, out] = args.as_slice() else {
        eprintln!("usage: gen_param_twin <tree> <defaults> <docs> <out>");
        return ExitCode::FAILURE;
    };
    let read = |path: &str| {
        std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))
    };
    let generate = || -> Result<String, String> {
        let twin = merge(
            &parse_tree(&read(tree)?)?,
            &parse_defaults(&read(defaults)?)?,
            &parse_docs(&read(docs)?),
        )?;
        let body = toml::to_string(&Document { param: twin })
            .map_err(|e| format!("TOML serialization failed: {e}"))?;
        Ok(format!("{HEADER}{body}"))
    };
    match generate() {
        Ok(document) => {
            if let Err(e) = std::fs::write(out, document) {
                eprintln!("cannot write {out}: {e}");
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

/// Scrapes the root *leaves* out of `dump-tree`: entries opened at column 0
/// (`├─`/`└─`) without a `[node]` tag, each carrying a `type=` detail line.
fn parse_tree(text: &str) -> Result<HashMap<String, TreeLeaf>, String> {
    let mut leaves = HashMap::new();
    let mut lines = text.lines().peekable();
    while let Some(line) = lines.next() {
        let Some(rest) = line.strip_prefix("├─ ").or(line.strip_prefix("└─ ")) else {
            continue;
        };
        if rest.contains("[node]") {
            continue;
        }
        let name = rest
            .split_whitespace()
            .next()
            .ok_or_else(|| format!("tree: empty entry header {line:?}"))?;
        let detail = lines
            .next()
            .filter(|l| l.contains("type="))
            .ok_or_else(|| format!("tree: `{name}` has no type= detail line"))?;
        leaves.insert(name.to_owned(), parse_detail(name, detail)?);
    }
    Ok(leaves)
}

/// Parses one `type=… len=… [min .. max] frac=…` detail line.
fn parse_detail(name: &str, detail: &str) -> Result<TreeLeaf, String> {
    let mut length = None;
    let mut min = None;
    let mut max = None;
    let mut frac_bits = None;
    for token in detail.split_whitespace() {
        if let Some(v) = token.strip_prefix("len=") {
            length = Some(v.parse().map_err(|e| format!("tree: {name} len: {e}"))?);
        } else if let Some(v) = token.strip_prefix("frac=") {
            frac_bits = Some(v.parse().map_err(|e| format!("tree: {name} frac: {e}"))?);
        } else if let Some(v) = token.strip_prefix('[') {
            min = Some(v.parse().map_err(|e| format!("tree: {name} min: {e}"))?);
        } else if let Some(v) = token.strip_suffix(']') {
            max = Some(v.parse().map_err(|e| format!("tree: {name} max: {e}"))?);
        }
    }
    match (length, min, max, frac_bits) {
        (Some(length), Some(min), Some(max), Some(frac_bits)) => Ok(TreeLeaf {
            length,
            min,
            max,
            frac_bits,
        }),
        _ => Err(format!("tree: `{name}` detail line incomplete: {detail:?}")),
    }
}

/// Parses `dump-defaults` — the ordered, authoritative root-leaf list:
/// one `name = v v v …` line per leaf.
fn parse_defaults(text: &str) -> Result<Vec<(String, Vec<i16>)>, String> {
    text.lines()
        .filter(|line| !line.starts_with('#') && !line.trim().is_empty())
        .map(|line| {
            let (name, values) = line
                .split_once('=')
                .ok_or_else(|| format!("defaults: no `=` in {line:?}"))?;
            let values = values
                .split_whitespace()
                .map(str::parse)
                .collect::<Result<Vec<i16>, _>>()
                .map_err(|e| format!("defaults: {}: {e}", name.trim()))?;
            Ok((name.trim().to_owned(), values))
        })
        .collect()
}

/// Scrapes root entries out of `dump-docs` (rule-divided
/// `4cc · Display Name` / `desc: …` / blank / verbatim help chunks);
/// nested entries carry a `/` path crumb and are skipped.
fn parse_docs(text: &str) -> HashMap<String, DocEntry> {
    let mut entries = HashMap::new();
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    // Rule lines are runs of `─`; split the document on them.
    for chunk in lines.split(|line| !line.is_empty() && line.chars().all(|c| c == '\u{2500}')) {
        let mut lines = chunk.iter().copied().skip_while(|l| l.is_empty());
        let Some(header) = lines.next() else { continue };
        if header.starts_with('#') {
            continue; // the dump's own comment banner
        }
        let (crumb, label) = match header.split_once(" \u{b7} ") {
            Some((crumb, label)) => (crumb.trim(), label.trim()),
            None => (header.trim(), header.trim()),
        };
        if crumb.contains('/') {
            continue; // nested under a node — not a root leaf
        }
        let Some(description) = lines.next().and_then(|l| l.strip_prefix("desc: ")) else {
            continue;
        };
        let help = lines.skip_while(|l| l.is_empty()).collect::<Vec<_>>();
        entries.insert(
            crumb.to_owned(),
            DocEntry {
                label: label.to_owned(),
                description: description.trim().to_owned(),
                help: help.join("\n").trim().to_owned(),
            },
        );
    }
    entries
}

/// Joins the three dumps in `dump-defaults` order, cross-checking that
/// every leaf appears everywhere and its default is `length`-sized.
fn merge(
    tree: &HashMap<String, TreeLeaf>,
    defaults: &[(String, Vec<i16>)],
    docs: &HashMap<String, DocEntry>,
) -> Result<Vec<TwinParam>, String> {
    defaults
        .iter()
        .map(|(name, default)| {
            let leaf = tree
                .get(name)
                .ok_or_else(|| format!("`{name}` is in dump-defaults but not dump-tree"))?;
            let doc = docs
                .get(name)
                .ok_or_else(|| format!("`{name}` is in dump-defaults but not dump-docs"))?;
            if default.len() != leaf.length {
                return Err(format!(
                    "`{name}`: {} default values but dump-tree len={}",
                    default.len(),
                    leaf.length
                ));
            }
            Ok(TwinParam {
                name: name.clone(),
                length: leaf.length,
                min: leaf.min,
                max: leaf.max,
                frac_bits: leaf.frac_bits,
                default: default.clone(),
                label: doc.label.clone(),
                description: doc.description.clone(),
                help: doc.help.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TREE: &str = "\
# AK object tree — 4-CC / name; leaves: type, len/size/off, [min..max], frac
├─ bver  Bundle version
│        type=2 len=5   size=0    off=0      [-32768 .. 32767] frac=0  flags=0x0027  read-only
│        Identifies the version of the bundle.
│
├─ gndb  gndb  [node]
│        Applies a db gain to all channels of audio.
│  │
│  └─ gain  gain
│           type=3 len=1   size=2    off=2      [-2080 .. 0] frac=4  flags=0x6027  read-only
│           Amount of gain to apply. Must be -ve
│
├─ dvla  Dolby Volume Leveling Amount
│        type=3 len=1   size=2    off=30     [0 .. 10] frac=0  flags=0x9025
│        Sets how much the leveler adjusts the loudness.
│
└─ lcpt  License Pointer
         type=3 len=1   size=1    off=276768 [0 .. 255] frac=0  flags=0x1825
         This parameter is for passing the license data.
";

    const DEFAULTS: &str = "\
# engine power-on defaults — root params, before any SET
bver = 4 28 9 0 0
dvla = 7
lcpt = 0
";

    const DOCS: &str = "\
# engine strings — every def's display name · one-line desc · long help
──────────────────────────────────────────────
bver · Bundle version
desc: Identifies the version of the bundle.

This parameter is automatically calculated.
- Note: always AK_DATATYPE_SHORT.
──────────────────────────────────────────────
gndb
desc: Applies a db gain to all channels of audio.
──────────────────────────────────────────────
gndb/gain · gain
desc: Amount of gain to apply. Must be -ve
──────────────────────────────────────────────
dvla · Dolby Volume Leveling Amount
desc: Sets how much the leveler adjusts the loudness.
──────────────────────────────────────────────
lcpt · License Pointer
desc: This parameter is for passing the license data.
──────────────────────────────────────────────
";

    #[test]
    fn scrapes_root_leaves_only_from_the_tree() {
        let leaves = parse_tree(TREE).unwrap();
        assert_eq!(leaves.len(), 3, "gndb is a node, gain is nested");
        let bver = &leaves["bver"];
        assert_eq!(
            (bver.length, bver.min, bver.max, bver.frac_bits),
            (5, -32768, 32767, 0)
        );
        assert_eq!(leaves["lcpt"].max, 255);
    }

    #[test]
    fn scrapes_ordered_defaults() {
        let defaults = parse_defaults(DEFAULTS).unwrap();
        assert_eq!(defaults[0], ("bver".to_owned(), vec![4, 28, 9, 0, 0]));
        assert_eq!(defaults[1], ("dvla".to_owned(), vec![7]));
    }

    #[test]
    fn scrapes_root_docs_with_verbatim_help() {
        let docs = parse_docs(DOCS);
        assert!(!docs.contains_key("gain"), "nested entries are skipped");
        let bver = &docs["bver"];
        assert_eq!(bver.label, "Bundle version");
        assert_eq!(bver.description, "Identifies the version of the bundle.");
        assert_eq!(
            bver.help,
            "This parameter is automatically calculated.\n- Note: always AK_DATATYPE_SHORT."
        );
        assert_eq!(docs["dvla"].help, "");
        assert_eq!(docs["gndb"].label, "gndb");
    }

    #[test]
    fn merges_in_defaults_order_and_serializes() {
        let twin = merge(
            &parse_tree(TREE).unwrap(),
            &parse_defaults(DEFAULTS).unwrap(),
            &parse_docs(DOCS),
        )
        .unwrap();
        assert_eq!(twin.len(), 3);
        assert_eq!(twin[0].name, "bver");
        assert_eq!(twin[2].name, "lcpt");
        let toml = toml::to_string(&Document { param: twin }).unwrap();
        assert!(toml.contains("[[param]]"), "unexpected shape:\n{toml}");
        assert!(toml.contains("default = [4, 28, 9, 0, 0]"));
    }

    #[test]
    fn rejects_a_default_length_disagreeing_with_the_tree() {
        let defaults = parse_defaults("bver = 4 28\n").unwrap();
        let err = merge(&parse_tree(TREE).unwrap(), &defaults, &parse_docs(DOCS)).unwrap_err();
        assert!(err.contains("bver"), "unhelpful: {err}");
    }
}
