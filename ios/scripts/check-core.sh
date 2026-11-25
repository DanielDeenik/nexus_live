#!/usr/bin/env bash
# Compiles the UI-free core files with plain swiftc (Linux or macOS, no Xcode) and runs their checks.
set -euo pipefail
cd "$(dirname "$0")/.."
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
swiftc -O -o "$out/checks" App/Sources/Core/PlanMath.swift App/Sources/Core/Deeplink.swift App/Sources/Core/Models.swift App/Sources/Core/SpendModels.swift Checks/plan_math_checks.swift Checks/deeplink_checks.swift Checks/spend_checks.swift Checks/main.swift
"$out/checks"
