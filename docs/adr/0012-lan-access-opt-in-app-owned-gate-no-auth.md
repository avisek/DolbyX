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
