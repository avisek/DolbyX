//! Behaviors 1–4 (issue #24, part A): the `vis` event feed — a pure
//! event stream off the main session's process blocks. One event per
//! block to every WS client, arrays verbatim under 4-CC keys; non-main
//! sessions emit nothing; no audio ⇒ no events; on the main session's
//! death the next-oldest becomes the source.

mod common;

use common::{connected, edit_param, recv_json, start_daemon, try_recv_json, vis_params_json};

/// One tiny interleaved-stereo block — the vis feed is about the
/// reply's tail, not the PCM.
const BLOCK: [i16; 8] = [0; 8];

/// Tracer bullet + behavior 1 (issue #24): every `process()` on the
/// main session broadcasts exactly one `vis` event carrying the
/// reply's five arrays verbatim, to every client (no originator rule);
/// once the calls stop the stream is silent — no timer refires.
#[tokio::test]
async fn each_main_session_block_broadcasts_one_vis_event_to_every_client() {
    let daemon = start_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut a = connected(daemon.addr()).await;
    let mut b = connected(daemon.addr()).await;

    let mut output = [0_i16; BLOCK.len()];
    for _ in 0..3 {
        daemon
            .handle
            .supervisor()
            .process(session, &BLOCK, &mut output)
            .expect("process");
    }

    let expected = vis_params_json(&ddp_engine::stub::fabricated_vis());
    for ws in [&mut a, &mut b] {
        for _ in 0..3 {
            let event = recv_json(ws).await;
            assert_eq!(event["type"], "vis");
            assert_eq!(event["params"], expected, "the fabricated tail, verbatim");
        }
        assert_eq!(
            try_recv_json(ws, 200).await,
            None,
            "calls stopped ⇒ the stream is silent"
        );
    }
}

/// Issue #105: the fifth array. Every `vis` event carries `params.gebg`
/// — the `gebg` the engine applied in the block that produced the
/// frame's `vcbg` — so after an `edit_profile` lands, the next frame
/// reports the edited curve (the stub echoes its last `set_params`).
#[tokio::test]
async fn vis_events_pair_vcbg_with_the_gebg_in_force() {
    let daemon = start_daemon().await;
    let session = daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;
    let mut output = [0_i16; BLOCK.len()];

    daemon
        .handle
        .supervisor()
        .process(session, &BLOCK, &mut output)
        .expect("process");
    let event = recv_json(&mut ws).await;
    assert_eq!(
        event["params"]["gebg"],
        serde_json::json!(vec![0; 20]),
        "the factory profile's flat gebg is in force"
    );

    let edited: Vec<i16> = (0..20).map(|band| band * 16 - 96).collect();
    edit_param(&mut ws, "music", "gebg", &edited).await;
    daemon
        .handle
        .supervisor()
        .process(session, &BLOCK, &mut output)
        .expect("process");
    let event = recv_json(&mut ws).await;
    assert_eq!(event["type"], "vis");
    assert_eq!(
        event["params"]["gebg"],
        serde_json::json!(edited),
        "the next frame carries the edited gebg"
    );
}

/// Behavior 2 (issue #24): only the main session sources the feed — a
/// non-main block emits nothing.
#[tokio::test]
async fn a_non_main_session_block_emits_nothing() {
    let daemon = start_daemon().await;
    let supervisor = daemon.handle.supervisor();
    let _main = supervisor.create_session(48000).expect("main");
    let second = supervisor.create_session(44100).expect("second");
    let mut ws = connected(daemon.addr()).await;

    let mut output = [0_i16; BLOCK.len()];
    supervisor
        .process(second, &BLOCK, &mut output)
        .expect("process");
    assert_eq!(try_recv_json(&mut ws, 200).await, None);
}

/// Behavior 3 (issue #24): the feed is process-driven, nothing else —
/// a live main session with no audio yields zero events (v1's pump
/// timer and the `vis_suspended` concept are dead).
#[tokio::test]
async fn no_audio_means_no_vis_events() {
    let daemon = start_daemon().await;
    daemon
        .handle
        .supervisor()
        .create_session(48000)
        .expect("session");
    let mut ws = connected(daemon.addr()).await;
    assert_eq!(try_recv_json(&mut ws, 300).await, None);
}

/// Behavior 4 (issue #24): the source switches only on the main
/// session's death — the next-oldest takes over.
#[tokio::test]
async fn main_session_death_hands_the_source_to_the_next_oldest() {
    let daemon = start_daemon().await;
    let supervisor = daemon.handle.supervisor();
    let first = supervisor.create_session(48000).expect("first");
    let second = supervisor.create_session(44100).expect("second");
    let mut ws = connected(daemon.addr()).await;

    supervisor.destroy_session(first).expect("destroy");
    let mut output = [0_i16; BLOCK.len()];
    supervisor
        .process(second, &BLOCK, &mut output)
        .expect("process");
    let event = recv_json(&mut ws).await;
    assert_eq!(event["type"], "vis", "the next-oldest sources the feed");
}
