//! Issue #21 behavior 3 and the tracer bullet's dry half: with the
//! daemon away the plugin passes audio through dry and bit-exact —
//! never stalling the host — and periodic reconnects pick the daemon
//! back up when it returns. Same policy when the daemon rejects a
//! `Hello`: no per-block retry storm, recovery on a throttled retry.

mod common;

use std::time::{Duration, Instant};

use common::{SyntheticHost, World, marked, tone};
use ddp_engine::EngineError;
use ddp_vst_windows::RETRY_INTERVAL;

/// Daemon down → dry (OUT == IN, promptly); daemon up → the next
/// throttled retry reconnects and blocks come back wet; daemon killed
/// mid-flight → the failing block itself falls back to dry.
#[test]
fn daemon_down_passes_dry_then_reconnects_when_it_returns() {
    let mut world = World::start_without_daemon();
    let host = SyntheticHost::load();
    host.set_sample_rate(48_000.0);
    host.resume(); // the eager connect fails fast; the link is throttled

    let (dry_left, dry_right) = tone(3, 64);
    let started = Instant::now();
    for _ in 0..20 {
        let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
        host.process(&mut left, &mut right);
        assert_eq!(left, dry_left, "daemon down ⇒ OUT == IN, bit-exact");
        assert_eq!(right, dry_right);
    }
    assert!(
        started.elapsed() < Duration::from_millis(500),
        "dry blocks never stall the host (took {:?})",
        started.elapsed()
    );
    assert_eq!(world.sessions_created(), 0, "nothing to connect to");

    // The daemon returns: the first block past the retry interval
    // reconnects (inside `process`) and is already wet.
    world.start_daemon();
    std::thread::sleep(RETRY_INTERVAL + Duration::from_millis(200));
    let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, marked(&dry_left), "reconnected: the block is wet");
    assert_eq!(world.sessions_created(), 1);

    // The daemon dies mid-flight: the failing block falls back to dry
    // — audio never stops — and stays dry while it's away.
    world.stop_daemon();
    for turn in 0..2 {
        let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
        host.process(&mut left, &mut right);
        assert_eq!(left, dry_left, "dry again after the loss (block {turn})");
    }
}

/// A `Hello` the daemon rejects (engine-side refusal) leaves the
/// plugin dry with its retries throttled — no glitch loop — and a
/// later retry lands once the engine accepts again.
#[test]
fn a_rejected_hello_stays_dry_and_recovers_on_a_later_retry() {
    let world = World::start();
    world.stub.fail_next(EngineError::UnsupportedConfig(
        "sample rate 96000 outside the engine's {44100, 48000, 32000}".into(),
    ));
    let host = SyntheticHost::load();
    host.set_sample_rate(48_000.0);
    host.resume(); // answered with a Goodbye — rejected, throttled

    let (dry_left, dry_right) = tone(5, 64);
    for turn in 0..2 {
        let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
        host.process(&mut left, &mut right);
        // The stub would accept a retry right now — staying dry inside
        // the throttle window is what "no retry storm" means.
        assert_eq!(left, dry_left, "rejected ⇒ dry, throttled (block {turn})");
    }

    std::thread::sleep(RETRY_INTERVAL + Duration::from_millis(200));
    let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, marked(&dry_left), "the throttled retry recovered");
    assert_eq!(world.sessions_created(), 1);
}
