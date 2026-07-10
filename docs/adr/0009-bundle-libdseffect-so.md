# Bundle `libdseffect.so` with releases

The proprietary `libdseffect.so` v2.0.4.0 ships alongside the daemon
binary, resolved at runtime from the same directory — ease-of-install
over legal cleanliness. Distribution is for personal use and the README
is explicit that DolbyX wraps a third-party proprietary binary; legal
review is deferred unless DolbyX is ever offered commercially. The
alternative — users extract the .so from a Dolby Module at install time —
adds friction without meaningfully changing the legal posture for
personal use.
