# Global EQ presets, GEQ owned by preset

EQ presets are top-level objects in DolbyX state, each owning its own
`iebt[20]` (IEQ band targets) and `gebg[20]` (GEQ band gains). Profiles
store only the **id** of their currently selected EQ preset, not their own
copy of the curves. This diverges from the original DDP, which carried a
6 × 4 × 20 matrix (profiles × presets × bands) — editing "Rich" in the
Music profile left "Rich" in Movie untouched. In DolbyX, an edit to
"Rich" propagates to every profile that has it currently selected,
matching the user's mental model that "Rich" is one preset, not four.
The price is loss of per-profile GEQ memory; we judge that an acceptable
simplification because the original UI never exposed it as a
user-discoverable feature.
