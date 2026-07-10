# Global EQ presets as optional overlays

Profiles are canonical — a profile can store any of the 52 non-readonly
params. An EQ preset is an **optional overlay** owning exactly the nine
EQ params (`genb gebf geon gebg` + `ienb iebf ieon iebt iea`;
eligibility is derived — `category ∈ {Ieq, Geq}` — not a flag). A
selected preset's nine values shadow the profile's own entirely; with
`None` selected the profile's own apply; EQ edits route to whichever is
effective.

Presets are top-level global objects — a profile stores only the selected
**id**. The original DDP instead kept a 6 × 4 × 20 matrix (profiles ×
presets × bands): editing "Rich" under Music left "Rich" under Movie
untouched. DolbyX drops that per-profile preset memory — an edit to
"Rich" propagates to every profile currently selecting it — matching the
mental model that "Rich" is one preset, not four. Acceptable because the
original UI never exposed the matrix as a discoverable feature. The
original's "Off" preset dies too: no-preset is `None`, and deleting a
selected preset falls back to `None`, not a magic entry.
