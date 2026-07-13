# ci-stubs

Minimal header stubs mirroring the *contract* the netcode overlay has with
pokeemerald (types, globals, function signatures). They let CI compile-check
`rom/overlay/src/*.c` with `arm-none-eabi-gcc` in seconds, without cloning the
decompilation or shipping any game data.

They are NOT the real headers. The real build (`rom/setup.sh`) is the source of
truth; if it fails where CI passed, a stub has drifted from upstream — update
the stub to match the real signature.
