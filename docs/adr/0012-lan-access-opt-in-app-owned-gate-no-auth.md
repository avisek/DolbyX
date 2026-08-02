# LAN access: opt-in app-owned gate, no auth

The Web UI is reachable from other LAN devices only while the
`lan_access` root scalar is on — an opt-in UI toggle persisted through
the Cascade ([ADR-0007](0007-toml-overlay-persistence-with-file-watcher.md);
`defaults.toml` ships `false`), flipping the HTTP/WS listener between
loopback and all-interfaces live, and severing established non-loopback
connections on off — a trust toggle that doesn't revoke is broken. The
gate is app-owned because the bind address is the only mechanism
identical on every platform: OS firewalls can't be the primary gate
(Windows profiles are commonly mis-marked — new networks default
Public; desktop Linux ships no active firewall; macOS's application
firewall is off by default). When enabled, every LAN device is trusted
equally — no auth, no pairing, no TLS: the blast radius is EQ state, an
appliance posture (Sonos/Chromecast), so Syncthing-style forced
credentials were rejected. Independent of the toggle, same-origin
hardening always applies: WS upgrades reject a cross-host `Origin`
(WS is CORS-exempt — any webpage in range could otherwise command the
daemon) and both routes reject a `Host` that is neither an IP literal
nor `localhost` (a rebound page's `Origin` agrees with its `Host`, so
only the `Host` check sees rebinding), closing drive-by tabs and DNS
rebinding. Belt, not gate: the Windows installer ships a
Private-profile, program-scoped inbound rule (Slice 22, #30) — services
never see the interactive firewall dialog. The port stays a `--port`
flag (dev/test knob, never user state); there is no `--bind` flag.

**Mechanism.** One listener, rebound IPv4-only between `127.0.0.1` and
`0.0.0.0` on each flip (dual-stack `::` was rejected: IPv4-mapped forms
would complicate exactly the check that decides who gets severed). The
bind target is hardcoded — no injection seam, **not even for tests**:
tests bind that same production target and reach it through the
machine's own routable address, because same-host traffic bypasses
inbound firewall filtering, measured on Windows and Linux. An earlier
attempt injected a `127.0.0.2` stand-in, which forced peer-vs-accept
address classification and a glossary term into being — test
scaffolding leaking into production vocabulary. A flip awaits the old
accept task's completion (which drops the listener) before binding,
rather than retrying a busy port: a port frees the moment its FD
closes, and live or `TIME_WAIT` connection sockets never block the
rebind, so a retry loop would only mask a race in our own shutdown.
Rebind first, sever second; if the new bind fails, re-bind the previous
address and answer `LAN_BIND_FAILED` — a deliberate third daemon-side
code, since reporting a busy port as `INVALID_REQUEST` would lie —
never ending a flip with nothing bound. Severing keys on the peer
address — loopback connections are never touched, in either direction —
and off closes both surfaces: non-loopback WebSocket tasks watch a
level-triggered gate and close on reading off, after flushing the reply
in hand, so a device flipping the toggle off hears its own `ack` before
the close (the reply law holds even when the reply severs the replier);
non-loopback HTTP connection tasks are aborted outright, so a lingering
keep-alive socket cannot serve a reload (upgraded WebSockets sit beyond
the abort — hyper's connection future resolves at upgrade). A severed
tab keeps its last snapshot, and its ordinary reconnect backoff is the
way back in should access return.

**Discovery.** Every snapshot carries a root `lan_url`, derived at
serialization like `readouts` — default-route interface pick plus the
bound port, `null` when routeless — never a `State` field, never
persisted, no set command. It is populated regardless of the toggle:
originator suppression starves the flipping tab of its own flip's
snapshot, so the QR shown on enable renders from data the tab already
holds; showing it only while on is UI policy. Recomputed per snapshot —
an IP change needs no restart, and an idle tab's stale window is
accepted over an interface poller.
