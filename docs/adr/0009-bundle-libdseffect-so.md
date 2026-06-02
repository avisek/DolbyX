# Bundle `libdseffect.so` with releases

The proprietary `libdseffect.so` v2.0.4.0 binary is shipped alongside the
DolbyX daemon executable, resolved at runtime from the same directory.
This is a deliberate trade-off: ease-of-install over legal cleanliness.
Distribution is for personal use; the project README is explicit that
DolbyX is a wrapper around a third-party proprietary binary. Legal
review is deferred until and unless DolbyX is offered as a commercial
product. The alternative — requiring users to extract the .so from a
Dolby-distributed APK at install time — adds friction without changing
the legal posture meaningfully for personal use.
