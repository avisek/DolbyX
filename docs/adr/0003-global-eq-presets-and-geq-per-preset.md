# Global EQ presets as optional overlays

Profiles are canonical: a profile stores values for any of the 52
non-readonly params. An EQ preset is an **optional overlay** owning
exactly the nine EQ params (`genb gebf geon gebg` + `ienb iebf ieon
iebt iea`); preset-eligibility is derived — `category ∈ {Ieq, Geq}` —
not a separate flag. While a profile has a preset attached, the preset's
nine values shadow the profile's own entirely (the preset resolves
complete through its own cascade layers,
[ADR-0007](0007-toml-overlay-persistence-with-file-watcher.md)); with
`selected_eq_preset = None` the profile's own EQ params apply. EQ edits
route to the attached preset, or to the profile when detached.

Presets are top-level, global objects — a profile stores only the **id**
of its selection. This diverges from the original DDP, which carried a
6 × 4 × 20 matrix (profiles × presets × bands): editing "Rich" in the
Music profile left "Rich" in Movie untouched. In DolbyX an edit to
"Rich" propagates to every profile that has it currently selected,
matching the user's mental model that "Rich" is one preset, not four.
The price is loss of per-profile preset memory; we judge that an
acceptable simplification because the original UI never exposed it as a
user-discoverable feature.

Factory presets are Open, Rich, Focused. The original's Off preset dies:
no-preset is `None`, and deleting a selected preset falls back to `None`
— the profile's own EQ curve — not to a magic entry.
