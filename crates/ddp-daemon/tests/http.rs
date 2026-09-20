//! Behavior 1 (issue #12): `GET /` serves the UI HTML with a valid
//! injected `window.__BOOTSTRAP__` — params (64 defs) + categories
//! (issue #83) + state.

mod common;

use common::{bootstrap_json, http_get, start_daemon};

#[tokio::test]
async fn get_root_serves_html_with_a_valid_bootstrap() {
    let daemon = start_daemon().await;
    let (status, body) = http_get(daemon.addr(), "/").await;

    assert_eq!(status, 200);
    assert!(
        !body.contains("<!--BOOTSTRAP-->"),
        "placeholder must be replaced"
    );

    let bootstrap = bootstrap_json(&body);
    let params = bootstrap["params"].as_array().expect("params array");
    assert_eq!(params.len(), 64);
    let dvla = params
        .iter()
        .find(|p| p["name"] == "dvla")
        .expect("dvla def present");
    assert_eq!(dvla["max"], 10);
    assert_eq!(dvla["access"], "settable");

    // The `[[category]]` table rides beside the params, in table order
    // (issue #83) — the UI hand-lists nothing.
    let categories = bootstrap["categories"]
        .as_array()
        .expect("categories array");
    assert_eq!(categories.len(), 15);
    assert_eq!(
        categories[0],
        serde_json::json!({
            "name": "volume_leveller",
            "label": "Volume Leveler",
            "params": ["dvla", "dvli", "dvlo", "dvle", "dvmc", "dvme"],
        })
    );
    assert_eq!(categories[14]["name"], "license");

    let state = &bootstrap["state"];
    assert_eq!(state["power"], true);
    assert_eq!(state["selected_profile"], "music");
    // The bootstrap state is the same snapshot the WS serves — readouts
    // included, so the first paint is fully populated (ADR-0006).
    assert_eq!(state["readouts"]["vnnb"], serde_json::json!([20]));
}
