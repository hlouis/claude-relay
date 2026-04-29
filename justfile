# Top-level task runner for the claude-relay monorepo.
# Install just: brew install just

default:
    @just --list

# --- Daemon (Clay) ---

# Install daemon dependencies.
daemon-install:
    cd daemon && npm install

# Run the daemon in dev mode.
daemon-dev:
    cd daemon && npm run dev

# Run the daemon test suite.
daemon-test:
    cd daemon && node --test test/

# Dry-run a release locally (no publish).
daemon-release-dry:
    cd daemon && npx semantic-release --dry-run --no-ci

# --- Apple (Clarc) ---

# Open the Xcode workspace.
mac-open:
    open apple/Clarc.xcodeproj

# Build the macOS app (Debug, no signing).
mac-build:
    cd apple && xcodebuild -project Clarc.xcodeproj -scheme Clarc -configuration Debug \
        -destination 'platform=macOS' \
        CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO build

# Run the macOS release script (signs + notarizes).
mac-release:
    cd apple && ./scripts/release.sh

# --- Protocol ---

# Validate the protocol schema (placeholder).
protocol-check:
    @echo "TODO: wire JSON schema validation when protocol/schema.json lands"
