#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "Building Porffor Explorer..."
npx esbuild explorer/compiler-bridge.js \
  --bundle \
  --format=esm \
  --platform=browser \
  --outfile=explorer/compiler-bundle.js \
  --inject:explorer/shims.js \
  --external:node:fs \
  --external:node:child_process \
  --external:@babel/parser \
  --external:hermes-parser \
  --external:meriyah \
  --external:oxc-parser \
  --log-level=error

echo "Done! Bundle size: $(du -h explorer/compiler-bundle.js | cut -f1)"
