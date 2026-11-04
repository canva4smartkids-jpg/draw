#!/bin/sh
# Fetch the real CorelDRAW regression files used by test/real-files.test.js.
#
# They come from LibreOffice's import-filter test data (MPL-2.0) and are not
# committed here. Only the three small files are checked out (sparse,
# blob-filtered clone), then verified by SHA-256.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/test/fixtures/external"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --filter=blob:none --no-checkout https://github.com/LibreOffice/core.git "$work/core"
cd "$work/core"
git sparse-checkout set --no-cone \
  'writerperfect/qa/unit/data/draw/libcdr/pass/fdo65220-2.cdr' \
  'writerperfect/qa/unit/data/draw/libcdr/pass/EDB-35217-2.cdr' \
  'writerperfect/qa/unit/data/draw/libcdr-cmx/pass/fdo63782-1.cmx'
git checkout --quiet

mkdir -p "$dest"
cp writerperfect/qa/unit/data/draw/libcdr/pass/fdo65220-2.cdr \
   writerperfect/qa/unit/data/draw/libcdr/pass/EDB-35217-2.cdr \
   writerperfect/qa/unit/data/draw/libcdr-cmx/pass/fdo63782-1.cmx "$dest/"

cd "$dest"
cat > SHA256SUMS <<'EOF'
88e62beb7a7ebe812f6ce06238017d07d215de9dbf76323dde93200f2d5dd348  fdo65220-2.cdr
10bbe0e281b70ca7b95c2f134191e099419c7b3a6c5899cd9d3474a7081d42df  EDB-35217-2.cdr
14c29eedec0d6e2b2cc2588bdee9997d0875364a2e6b0cde7ee1ee4620493e80  fdo63782-1.cmx
EOF
sha256sum -c SHA256SUMS
echo "fixtures ready in $dest"
