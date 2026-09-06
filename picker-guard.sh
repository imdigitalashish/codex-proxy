#!/bin/sh
set -eu
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "${BUN_BIN:-bun}" "$script_dir/picker-guard.ts" "$@"
