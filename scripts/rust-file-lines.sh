#!/usr/bin/env bash
# AGENTS.md "Desktop — Tauri + Rust": a file holds at most 300 lines of code. Comments and blank
# lines cost nothing, so the long explanations this codebase runs on are
# free; a file's own `#[cfg(test)]` module and the integration tests under
# crates/*/tests/ are exempt, as tests are in the TypeScript lint.
# Function length (50) and parameters (4) are clippy's, in clippy.toml.
set -euo pipefail
cd "$(dirname "$0")/.."
limit=300
over=0
while IFS= read -r file; do
  lines=$(awk '
    /^#\[cfg\(test\)\]/ { exit }
    {
      line = $0
      if (in_block) {
        if (line ~ /\*\//) { in_block = 0; sub(/.*\*\//, "", line) } else next
      }
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "") next
      if (line ~ /^\/\//) next
      if (line ~ /^\/\*/) { if (line !~ /\*\//) in_block = 1; next }
      count++
    }
    END { print count + 0 }
  ' "$file")
  if [ "$lines" -gt "$limit" ]; then
    echo "✗ $file: $lines lines of code (limit $limit)"
    over=1
  fi
done < <(find crates apps/desktop/src-tauri/src -name '*.rs' -not -path '*/tests/*' -not -path '*/target/*' | sort)
exit "$over"
