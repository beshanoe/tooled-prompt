#!/usr/bin/env bash
set -euo pipefail

SKIP=("chat.ts" "env.ts")
FAILED=()
PASSED=()

cd "$(dirname "$0")/.."

for f in examples/*.ts; do
  f=$(basename "$f")
  skip=false
  for s in "${SKIP[@]}"; do
    [[ "$f" == "$s" ]] && skip=true && break
  done
  $skip && continue

  echo "━━━ $f ━━━"
  if npx tsx "examples/$f"; then
    PASSED+=("$f")
  else
    FAILED+=("$f")
  fi
  echo
done

echo "━━━ Summary ━━━"
echo "Passed: ${#PASSED[@]}"
echo "Failed: ${#FAILED[@]}"
for f in "${FAILED[@]}"; do
  echo "  ✗ $f"
done

[[ ${#FAILED[@]} -eq 0 ]]
