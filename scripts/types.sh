#!/bin/sh
# Generates src/api/airavata.ts from the CyberShuttle API spec: $AIRAVATA_SPEC, else a sibling
# airavata checkout, else the commit pinned in .airavata-ref.
set -e
cd "$(dirname "$0")/.."
sibling=../airavata/docs/openapi.yaml
pinned="https://raw.githubusercontent.com/yasithdev/airavata/$(cat .airavata-ref)/docs/openapi.yaml"
spec="${AIRAVATA_SPEC:-$([ -f "$sibling" ] && echo "$sibling" || echo "$pinned")}"
exec openapi-typescript "$spec" -o src/api/airavata.ts
