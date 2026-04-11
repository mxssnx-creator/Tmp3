#!/bin/bash
# Removes standalone console.log/warn("[v0] ...") lines from all .ts and .tsx files
# under components/, app/, and lib/ directories.
# Uses grep -rl to find matching files, then perl to do safe in-place removal.

ROOT="/vercel/share/v0-project"
TARGETS=("$ROOT/components" "$ROOT/app" "$ROOT/lib")

# The pattern: any line that is ONLY a console.log or console.warn starting with [v0]
# (the line may have leading whitespace, may end with a semicolon)
# Uses perl for reliable in-place multiline-safe line removal.

PATTERN='console\.(log|warn)\([\x60\x27"]\[v0\]'

total_files=0
total_lines=0

for dir in "${TARGETS[@]}"; do
  # Find all .ts and .tsx files containing the pattern
  while IFS= read -r -d '' file; do
    before=$(grep -c "$PATTERN" "$file" 2>/dev/null || echo 0)
    if [ "$before" -gt 0 ]; then
      perl -i -ne 'print unless /^\s*console\.(log|warn)\([\x60\x27"][[]v0[]]/' "$file"
      after=$(grep -c "$PATTERN" "$file" 2>/dev/null || echo 0)
      removed=$((before - after))
      if [ "$removed" -gt 0 ]; then
        echo "  Cleaned ($removed lines): ${file#$ROOT/}"
        total_files=$((total_files + 1))
        total_lines=$((total_lines + removed))
      fi
    fi
  done < <(find "$dir" \( -name "*.ts" -o -name "*.tsx" \) \
    -not -path "*/node_modules/*" \
    -not -path "*/.next/*" \
    -not -path "*/backup/*" \
    -print0)
done

echo ""
echo "Done. Modified $total_files files, removed ~$total_lines debug log lines."
