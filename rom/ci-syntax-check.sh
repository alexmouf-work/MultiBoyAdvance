#!/usr/bin/env bash
# Compile-check the netcode overlay against the stub contract (rom/ci-stubs).
# Used by CI; also handy locally when the pokeemerald clone isn't around.
set -euo pipefail
cd "$(dirname "$0")"

CC=arm-none-eabi-gcc
command -v "$CC" >/dev/null || CC=gcc

fail=0
for f in overlay/src/net_*.c; do
  if "$CC" -fsyntax-only -std=c11 -Wall -Wextra -Werror -mthumb -Ici-stubs -Ioverlay/include "$f" 2>/tmp/mba-cc-err; then
    echo "ok   $f"
  else
    echo "FAIL $f"
    cat /tmp/mba-cc-err
    fail=1
  fi
done
exit $fail
