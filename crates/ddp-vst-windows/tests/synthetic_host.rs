//! Issue #21 behaviors 2 + 6 and the tracer bullet: a synthetic VST2
//! host drives the exported entry against a real in-process daemon
//! over the real platform socket — `StubBackend` behind the `Engine`
//! trait (its marker contract: enabled → bitwise NOT), nothing else
//! mocked.

mod common;

use common::{SyntheticHost, World, marked, tone, wait_until};
use ddp_engine::stub::Call;

/// Behavior 2: resume connects the pipe and sends `Hello` from the
/// host's processing setup — the engine session runs at the host's
/// rate, never a default.
#[test]
fn resume_sends_hello_at_the_hosts_rate() {
    let world = World::start();
    let host = SyntheticHost::load();
    host.set_sample_rate(44_100.0);
    host.resume();
    // The handshake is synchronous: by now the session exists.
    world.session_at(44_100);
    assert_eq!(world.sessions_created(), 1, "one Hello, one session");
}

/// Behavior 2 + the tracer bullet's wet half: a processed block comes
/// back engine-transformed — output ≠ input, and exactly the stub's
/// marker seen through the float boundary.
#[test]
fn process_ferries_audio_through_the_engine() {
    let world = World::start();
    let host = SyntheticHost::load();
    host.set_sample_rate(48_000.0);
    host.resume();

    let (dry_left, dry_right) = tone(3, 64);
    let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, marked(&dry_left), "left ferried through the engine");
    assert_eq!(
        right,
        marked(&dry_right),
        "right ferried through the engine"
    );
    assert_ne!(left, dry_left, "output ≠ input while the daemon is up");
    world.session_at(48_000);
}

/// A host block past the `Hello`'d `MAX_FRAMES` promise is ferried in
/// chunks over the same session — no re-`Hello`, no protocol
/// violation, the whole block wet.
#[test]
fn an_oversized_block_is_chunked_through_one_session() {
    let world = World::start();
    let host = SyntheticHost::load();
    host.set_sample_rate(48_000.0);
    host.resume();

    let frames = usize::try_from(ddp_vst_windows::DEFAULT_MAX_FRAMES).unwrap() * 2 + 1000;
    let (dry_left, dry_right) = tone(7, frames);
    let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, marked(&dry_left), "every chunk came back wet");
    assert_eq!(right, marked(&dry_right));
    assert_eq!(world.sessions_created(), 1, "chunking reuses the session");
}

/// Behavior 2: suspend says `Goodbye` (the session dies); a later
/// resume opens a fresh session and audio ferries again.
#[test]
fn suspend_says_goodbye_and_resume_reconnects() {
    let world = World::start();
    let host = SyntheticHost::load();
    host.set_sample_rate(48_000.0);
    host.resume();
    let session = world.session_at(48_000);

    host.suspend();
    let stub = world.stub.clone();
    wait_until(
        move || stub.calls().contains(&Call::DestroySession(session)),
        "suspend's Goodbye destroys the session",
    );

    host.resume();
    assert_eq!(world.sessions_created(), 2, "resume opens a fresh session");
    let (dry_left, dry_right) = tone(5, 32);
    let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, marked(&dry_left), "audio ferries after the cycle");
}

/// Sessions are rate-immutable (epic #8): a rate change from the host
/// is `Goodbye` + fresh `Hello` at the new rate — and a same-rate
/// repeat is not churn.
#[test]
fn a_rate_change_goodbyes_and_rehellos() {
    let world = World::start();
    let host = SyntheticHost::load();
    host.set_sample_rate(44_100.0);
    host.resume();
    let old_session = world.session_at(44_100);

    host.set_sample_rate(48_000.0);
    world.session_at(48_000);
    let stub = world.stub.clone();
    wait_until(
        move || stub.calls().contains(&Call::DestroySession(old_session)),
        "the old-rate session dies",
    );

    host.set_sample_rate(48_000.0);
    assert_eq!(world.sessions_created(), 2, "a same-rate repeat is a no-op");

    let (dry_left, dry_right) = tone(9, 32);
    let (mut left, mut right) = (dry_left.clone(), dry_right.clone());
    host.process(&mut left, &mut right);
    assert_eq!(left, marked(&dry_left), "audio ferries at the new rate");
}

/// Behavior 6: two plugin instances hold independent sessions — each
/// hears its own tone back, interleaved, with no crosstalk.
#[test]
fn two_instances_hold_independent_sessions_without_crosstalk() {
    let world = World::start();
    let host_a = SyntheticHost::load();
    let host_b = SyntheticHost::load();
    host_a.set_sample_rate(48_000.0);
    host_b.set_sample_rate(44_100.0);
    host_a.resume();
    host_b.resume();
    assert_ne!(
        world.session_at(48_000),
        world.session_at(44_100),
        "distinct sessions"
    );

    let (tone_a, _) = tone(3, 48);
    let (tone_b, _) = tone(11, 48);
    for _ in 0..3 {
        let (mut left, mut right) = (tone_a.clone(), tone_a.clone());
        host_a.process(&mut left, &mut right);
        assert_eq!(left, marked(&tone_a), "a hears a");

        let (mut left, mut right) = (tone_b.clone(), tone_b.clone());
        host_b.process(&mut left, &mut right);
        assert_eq!(left, marked(&tone_b), "b hears b");
    }
}

/// `effClose` destroys the instance's session — however the host ends
/// (drop dispatches `effClose`), the daemon sees the plugin leave.
#[test]
fn closing_the_plugin_destroys_its_session() {
    let world = World::start();
    let host = SyntheticHost::load();
    host.set_sample_rate(32_000.0);
    host.resume();
    let session = world.session_at(32_000);

    drop(host);
    let stub = world.stub.clone();
    wait_until(
        move || stub.calls().contains(&Call::DestroySession(session)),
        "effClose destroys the session",
    );
}
