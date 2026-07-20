#!/usr/bin/env bash
# Compile-check the netcode overlay against the stub contract (rom/ci-stubs).
# Used by CI; also handy locally when the pokeemerald clone isn't around.
#
# We compile to real object files (not just -fsyntax-only) and then assert the
# .data section is empty. pokeemerald's modern ld script DISCARDS .data, so a
# non-zero-initialised, non-const static/global compiles fine but fails to LINK
# ("`.data' referenced ... defined in discarded section `.data'"). Zero-init
# such statics (.bss) and set them at runtime, or make them const (.rodata).
set -euo pipefail
cd "$(dirname "$0")"

CC=arm-none-eabi-gcc
command -v "$CC" >/dev/null || CC=gcc
# Matching size tool (arm-none-eabi-gcc -> arm-none-eabi-size; gcc -> size).
SIZE="${CC%gcc}size"
command -v "$SIZE" >/dev/null || SIZE=""

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
for f in overlay/src/net_*.c; do
  obj="$tmp/$(basename "$f").o"
  if ! "$CC" -c -std=c11 -Wall -Wextra -Werror -mthumb -Ici-stubs -Ioverlay/include "$f" -o "$obj" 2>"$tmp/err"; then
    echo "FAIL $f"
    cat "$tmp/err"
    fail=1
    continue
  fi
  # Berkeley `size` columns: text data bss dec hex filename.
  data=0
  [ -n "$SIZE" ] && data="$("$SIZE" "$obj" | awk 'NR==2 {print $2}')"
  if [ "${data:-0}" != "0" ]; then
    echo "FAIL $f — ${data} bytes of .data (discarded by pokeemerald's modern ld;"
    echo "     zero-init the static + set it at runtime, or make it const)"
    fail=1
  else
    echo "ok   $f"
  fi
done
exit $fail
