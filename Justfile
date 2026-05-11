# Justfile — task runner for ai-orchestrator
# Alternative to npm scripts; provides faster, cleaner prefixed output.
# Requires: https://github.com/casey/just
# Install: brew install just  |  cargo install just
#
# Motivation: claude3.md §19 — replace concurrently's ad-hoc chaining with a
# proper task-dependency graph and readable command aliases.
#
# Usage:
#   just          # list available recipes
#   just dev      # start dev mode (Angular + Electron)
#   just typecheck # run all TS checks
#   just test      # run test suite
#   just verify    # full pre-PR gate

set shell := ["zsh", "-euo", "pipefail", "-c"]

# Default recipe — list all
[private]
default:
    @just --list

# ── Development ───────────────────────────────────────────────────────────────

# Start dev mode: builds main, watches, starts renderer + Electron
dev:
    npm run dev

# Build main process only (fast iteration)
build-main:
    npm run build:main

# Watch main process TypeScript (keeps recompiling on change)
watch-main:
    npm run watch:main

# ── Building ──────────────────────────────────────────────────────────────────

# Full production build (renderer + main + worker agent)
build:
    npm run build

# Build renderer (Angular production build)
build-renderer:
    npm run build:renderer

# Build worker agent SEA binary
build-worker:
    npm run build:worker-dist

# Build and package as DMG (runs electron-builder)
package:
    npm run localbuild

# ── Code Generation ───────────────────────────────────────────────────────────

# Regenerate src/main/register-aliases.ts from tsconfig paths
gen-aliases:
    node scripts/generate-register-aliases.js

# Regenerate preload IPC channel bindings from contracts
gen-ipc:
    node scripts/generate-preload-channels.js

# Regenerate architecture inventory
gen-arch:
    node scripts/generate-architecture-inventory.js --write

# ── Quality Checks ────────────────────────────────────────────────────────────

# Fast lint via oxlint
lint-fast:
    npm run lint:fast

# Full lint via ng lint (Angular ESLint)
lint:
    npm run lint

# TypeScript type-check (renderer + main process)
typecheck:
    npm run typecheck

# TypeScript type-check spec files
typecheck-spec:
    npm run typecheck:spec

# Experimental fast typecheck via tsgo
typecheck-fast:
    npm run typecheck:fast

# Verify IPC channels match contracts
verify-ipc:
    node scripts/verify-ipc-channels.js

# Verify package exports
verify-exports:
    node scripts/verify-package-exports.js

# Check contract alias drift
check-contracts:
    tsx scripts/check-contracts-aliases.ts

# Enforce import boundary rules
check-boundaries:
    node scripts/check-import-boundaries.js

# Run all architecture verification checks
verify-arch:
    npm run verify:architecture

# Electron smoke check (no GUI)
smoke:
    node scripts/electron-smoke-check.js

# ── Tests ─────────────────────────────────────────────────────────────────────

# Run full test suite (vitest)
test:
    npm run test

# Run tests in watch mode
test-watch:
    npm run test:unit

# Run tests with coverage
coverage:
    npm run test:coverage

# ── Native Modules ────────────────────────────────────────────────────────────

# Rebuild native modules against current Electron ABI
rebuild-native:
    npm run rebuild:native

# Fetch RTK binaries for current platform
fetch-rtk:
    npm run fetch:rtk

# ── Full Gate ─────────────────────────────────────────────────────────────────

# Run the complete pre-PR verification gate
verify:
    npm run verify

# Quick pre-commit gate (lint-fast + typecheck + tests, no smoke/rebuild)
quick-check: lint-fast typecheck typecheck-spec verify-ipc test
