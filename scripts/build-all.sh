#!/usr/bin/env bash
#
# Build omega binaries for all common platforms locally.
# Bash counterpart of scripts/build-all.ps1; mirrors the packaging layout of
# .github/workflows/build-binaries.yml.
#
# Usage:
#   ./scripts/build-all.sh [--skip-install] [--skip-deps] [--skip-build] \
#       [--offline-model-data] [--platform <platform>] [--out <dir>] [--skip-smoke-test]
#
# Options:
#   --skip-install       Skip npm ci
#   --skip-deps          Skip installing cross-platform dependencies
#   --skip-build         Skip the package build
#   --offline-model-data Build with bundled model data instead of refreshing it
#   --platform <name>    Build only for specified platform (darwin-arm64, darwin-x64,
#                        linux-x64, linux-arm64, windows-x64, windows-arm64)
#   --out <dir>          Output directory (default: out)
#   --skip-smoke-test    Skip running the host-compatible executable after extraction
#
# Output (<out>/):
#   omega-darwin-arm64.tar.gz
#   omega-darwin-x64.tar.gz
#   omega-linux-x64.tar.gz
#   omega-linux-arm64.tar.gz
#   omega-windows-x64.zip
#   omega-windows-arm64.zip

set -euo pipefail

cd "$(dirname "$0")/.."

OMEGA_VERSION=$(node -p "require('./packages/omega-core/package.json').version")
readonly OMEGA_VERSION

SKIP_INSTALL=false
SKIP_DEPS=false
SKIP_BUILD=false
OFFLINE_MODEL_DATA=false
SKIP_SMOKE_TEST=false
PLATFORM=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-install)
            SKIP_INSTALL=true
            shift
            ;;
        --skip-deps)
            SKIP_DEPS=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --offline-model-data)
            OFFLINE_MODEL_DATA=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --out)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --skip-smoke-test)
            SKIP_SMOKE_TEST=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

ALL_PLATFORMS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64 windows-x64 windows-arm64)

# Validate platform if specified
if [[ -n "$PLATFORM" ]]; then
    case "$PLATFORM" in
        darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64|windows-arm64)
            ;;
        *)
            echo "Invalid platform: $PLATFORM"
            echo "Valid platforms: ${ALL_PLATFORMS[*]}"
            exit 1
            ;;
    esac
fi

if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="out"
fi
if [[ "$OUTPUT_DIR" != /* ]]; then
    OUTPUT_DIR="$(pwd)/$OUTPUT_DIR"
fi

is_windows_platform() {
    [[ "$1" == windows-* ]]
}

clipboard_native_package() {
    case "$1" in
        darwin-arm64)  echo "clipboard-darwin-arm64" ;;
        darwin-x64)    echo "clipboard-darwin-x64" ;;
        linux-arm64)   echo "clipboard-linux-arm64-gnu" ;;
        linux-x64)     echo "clipboard-linux-x64-gnu" ;;
        windows-arm64) echo "clipboard-win32-arm64-msvc" ;;
        windows-x64)   echo "clipboard-win32-x64-msvc" ;;
        *) echo "Unsupported platform: $1" >&2; exit 1 ;;
    esac
}

clipboard_native_file() {
    case "$1" in
        darwin-arm64)  echo "clipboard.darwin-arm64.node" ;;
        darwin-x64)    echo "clipboard.darwin-x64.node" ;;
        linux-arm64)   echo "clipboard.linux-arm64-gnu.node" ;;
        linux-x64)     echo "clipboard.linux-x64-gnu.node" ;;
        windows-arm64) echo "clipboard.win32-arm64-msvc.node" ;;
        windows-x64)   echo "clipboard.win32-x64-msvc.node" ;;
        *) echo "Unsupported platform: $1" >&2; exit 1 ;;
    esac
}

echo "==> OMEGA version: $OMEGA_VERSION"

# ---------------------------------------------------------------------------
# 1. Dependencies
# ---------------------------------------------------------------------------
if [[ "$SKIP_INSTALL" == "false" ]]; then
    echo "==> Installing dependencies..."
    npm ci --ignore-scripts
else
    echo "==> Skipping npm ci (--skip-install)"
fi

# ---------------------------------------------------------------------------
# 2. Cross-platform native bindings (clipboard)
# ---------------------------------------------------------------------------
if [[ "$SKIP_DEPS" == "false" ]]; then
    echo "==> Installing cross-platform native bindings..."
    CLIPBOARD_VERSION=$(node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']")
    # npm ci only installs optional deps for the current platform. Install the
    # cross-platform packages in isolation so npm does not re-resolve and mutate
    # the workspace dependency graph, which can trigger npm/arborist failures.
    NATIVE_DEPS_DIR=$(mktemp -d)
    cleanup_native_deps() {
        rm -rf "$NATIVE_DEPS_DIR"
    }
    trap cleanup_native_deps EXIT
    printf '%s\n' '{"private":true}' > "$NATIVE_DEPS_DIR/package.json"
    # Use --force to bypass platform checks (os/cpu restrictions in package.json).
    npm install --prefix "$NATIVE_DEPS_DIR" --include=optional --no-save --package-lock=false --force --ignore-scripts \
        @mariozechner/clipboard@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-arm64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-darwin-x64@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-x64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-linux-arm64-gnu@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-x64-msvc@"$CLIPBOARD_VERSION" \
        @mariozechner/clipboard-win32-arm64-msvc@"$CLIPBOARD_VERSION"
    mkdir -p node_modules/@mariozechner
    for package in \
        clipboard \
        clipboard-darwin-arm64 \
        clipboard-darwin-x64 \
        clipboard-linux-x64-gnu \
        clipboard-linux-arm64-gnu \
        clipboard-win32-x64-msvc \
        clipboard-win32-arm64-msvc; do
        rm -rf "node_modules/@mariozechner/$package"
        cp -R "$NATIVE_DEPS_DIR/node_modules/@mariozechner/$package" node_modules/@mariozechner/
    done
    cleanup_native_deps
    trap - EXIT
else
    echo "==> Skipping cross-platform native bindings (--skip-deps)"
fi

# ---------------------------------------------------------------------------
# 3. Package build
# ---------------------------------------------------------------------------
if [[ "$SKIP_BUILD" == "false" ]]; then
    if [[ "$OFFLINE_MODEL_DATA" == "true" ]]; then
        echo "==> Building all packages with bundled model data..."
        npm run build:offline
    else
        echo "==> Building all packages..."
        npm run build
    fi
else
    echo "==> Skipping package build (--skip-build)"
fi

# ---------------------------------------------------------------------------
# 4. Compile binaries with Bun (cross-compile)
# ---------------------------------------------------------------------------
echo "==> Building binaries..."
cd packages/coding-agent

OMEGA_ENTRY="../omega-core/dist/bun/cli.js"
OMEGA_DIST="../omega-core/dist"
IMAGE_WORKER="src/utils/image-resize-worker.ts"

if [[ ! -f "$OMEGA_ENTRY" ]]; then
    echo "OMEGA binary entry is missing: $OMEGA_ENTRY. Run without --skip-build first." >&2
    exit 1
fi

# Bun only embeds files that are part of the compile inputs. Omega loads its
# bundled prompts, agent definitions, and contract evidence through fs at
# runtime, so include those non-code resources explicitly in the executable.
OMEGA_ASSETS=(
    "$OMEGA_DIST/prompts"
    "$OMEGA_DIST/subagents/agents"
    "$OMEGA_DIST/background/core/delegate/hook-contract-evidence.json"
)
for asset in "${OMEGA_ASSETS[@]}"; do
    if [[ ! -e "$asset" ]]; then
        echo "OMEGA bundled asset is missing: $asset. Run without --skip-build first." >&2
        exit 1
    fi
done
ASSET_ARGS=()
for asset in "${OMEGA_ASSETS[@]}"; do
    ASSET_ARGS+=("--asset=$asset")
done

if [[ -n "$PLATFORM" ]]; then
    PLATFORMS=("$PLATFORM")
else
    PLATFORMS=("${ALL_PLATFORMS[@]}")
fi

# Clean only the requested platform outputs.
mkdir -p "$OUTPUT_DIR"
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$OUTPUT_DIR/$platform"
    mkdir -p "$OUTPUT_DIR/$platform"
    if is_windows_platform "$platform"; then
        rm -f "$OUTPUT_DIR/omega-$platform.zip"
    else
        rm -f "$OUTPUT_DIR/omega-$platform.tar.gz"
    fi
done

for platform in "${PLATFORMS[@]}"; do
    echo "  Building $platform..."
    bun_target="bun-$platform"
    if [[ "$platform" == *-x64 ]]; then
        bun_target="${bun_target}-baseline"
    fi

    # Bun compiled executables only embed worker scripts when they are passed as
    # explicit build entrypoints. The runtime can still use new URL(...), but the
    # worker must be present in the compiled executable.
    #
    # Disable cwd bunfig.toml autoload so project preload scripts cannot crash the
    # standalone binary before pi starts (see #7684).
    if is_windows_platform "$platform"; then
        bun build --compile --no-compile-autoload-bunfig --target="$bun_target" \
            "$OMEGA_ENTRY" "$IMAGE_WORKER" \
            "${ASSET_ARGS[@]}" \
            --outfile "$OUTPUT_DIR/$platform/omega.exe"
    else
        bun build --compile --no-compile-autoload-bunfig --target="$bun_target" \
            "$OMEGA_ENTRY" "$IMAGE_WORKER" \
            "${ASSET_ARGS[@]}" \
            --outfile "$OUTPUT_DIR/$platform/omega"
    fi
    echo "  -> $OUTPUT_DIR/$platform"
done

# ---------------------------------------------------------------------------
# 5. Copy shared assets
# ---------------------------------------------------------------------------
echo "==> Copying assets..."

for platform in "${PLATFORMS[@]}"; do
    dest="$OUTPUT_DIR/$platform"

    # Metadata & docs
    cp package.json "$dest/"
    npm pkg set "version=$OMEGA_VERSION" --prefix "$dest"
    for f in README.md CHANGELOG.md; do
        [[ -f "$f" ]] && cp "$f" "$dest/"
    done

    # WASM
    wasm_src="../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"
    [[ -f "$wasm_src" ]] && cp "$wasm_src" "$dest/"

    # Theme
    mkdir -p "$dest/theme"
    cp dist/modes/interactive/theme/*.json "$dest/theme/" 2>/dev/null || true

    # Assets
    mkdir -p "$dest/assets"
    cp -R dist/modes/interactive/assets/* "$dest/assets/" 2>/dev/null || true

    # Export-html & docs & examples
    for dir in dist/core/export-html docs examples; do
        [[ -e "$dir" ]] && cp -R "$dir" "$dest/"
    done

    # Clipboard native binding
    native_pkg=$(clipboard_native_package "$platform")
    native_file=$(clipboard_native_file "$platform")
    mkdir -p "$dest/node_modules/@mariozechner"
    if [[ ! -d "../../node_modules/@mariozechner/clipboard" ]]; then
        echo "Clipboard package is missing. Run without --skip-deps first." >&2
        exit 1
    fi
    if [[ ! -d "../../node_modules/@mariozechner/$native_pkg" ]]; then
        echo "$native_pkg is missing. Run without --skip-deps first." >&2
        exit 1
    fi
    cp -R "../../node_modules/@mariozechner/clipboard" "$dest/node_modules/@mariozechner/"
    cp -R "../../node_modules/@mariozechner/$native_pkg" "$dest/node_modules/@mariozechner/"
    cp "../../node_modules/@mariozechner/$native_pkg/$native_file" \
        "$dest/node_modules/@mariozechner/clipboard/"

    # Platform-specific terminal native helpers
    if [[ "$platform" == darwin-* ]]; then
        darwin_helper="../tui/native/darwin/prebuilds/$platform/darwin-modifiers.node"
        if [[ -f "$darwin_helper" ]]; then
            mkdir -p "$dest/native/darwin/prebuilds/$platform"
            cp "$darwin_helper" "$dest/native/darwin/prebuilds/$platform/"
        fi
    fi
    if is_windows_platform "$platform"; then
        if [[ "$platform" == "windows-arm64" ]]; then
            win32_arch_dir="win32-arm64"
        else
            win32_arch_dir="win32-x64"
        fi
        win32_helper="../tui/native/win32/prebuilds/$win32_arch_dir/win32-console-mode.node"
        if [[ -f "$win32_helper" ]]; then
            mkdir -p "$dest/native/win32/prebuilds/$win32_arch_dir"
            cp "$win32_helper" "$dest/native/win32/prebuilds/$win32_arch_dir/"
        fi
    fi
done

# ---------------------------------------------------------------------------
# 6. Create archives
#    - windows-* -> .zip
#    - others    -> .tar.gz with a top-level "omega" wrapper directory
#      (mise compatibility)
# ---------------------------------------------------------------------------
echo "==> Creating archives..."
cd "$OUTPUT_DIR"

for platform in "${PLATFORMS[@]}"; do
    if is_windows_platform "$platform"; then
        echo "  Creating omega-$platform.zip..."
        (cd "$platform" && zip -qr "../omega-$platform.zip" .)
    else
        echo "  Creating omega-$platform.tar.gz..."
        rm -rf omega
        mv "$platform" omega
        tar -czf "omega-$platform.tar.gz" omega
        mv omega "$platform"
    fi
done

# ---------------------------------------------------------------------------
# 7. Extract archives for easy local testing / inspection
# ---------------------------------------------------------------------------
echo "==> Extracting archives for testing..."
for platform in "${PLATFORMS[@]}"; do
    rm -rf "$platform"
    if is_windows_platform "$platform"; then
        mkdir -p "$platform" && (cd "$platform" && unzip -q "../omega-$platform.zip")
    else
        rm -rf omega
        tar -xzf "omega-$platform.tar.gz"
        mv omega "$platform"
    fi
done

# ---------------------------------------------------------------------------
# 8. Smoke test host-compatible output
# ---------------------------------------------------------------------------
if [[ "$SKIP_SMOKE_TEST" == "false" ]]; then
    echo "==> Smoke testing host-compatible executable..."
    arch=$(uname -m)
    suffix="x64"
    if [[ "$arch" == "arm64" || "$arch" == "aarch64" ]]; then
        suffix="arm64"
    fi
    if [[ "$(uname -s)" == "Darwin" ]]; then
        host_platform="darwin-$suffix"
        host_exe="omega"
    elif [[ "$(uname -s)" == *NT* || -n "${WINDIR:-}" ]]; then
        host_platform="windows-$suffix"
        host_exe="omega.exe"
    else
        host_platform="linux-$suffix"
        host_exe="omega"
    fi

    build_includes_host=false
    for platform in "${PLATFORMS[@]}"; do
        [[ "$platform" == "$host_platform" ]] && build_includes_host=true
    done

    if [[ "$build_includes_host" == "true" ]]; then
        smoke_root=$(mktemp -d)
        (
            export OMEGA_CODING_AGENT_DIR="$smoke_root/agent"
            export PI_OFFLINE=1
            "$OUTPUT_DIR/$host_platform/$host_exe" --plan --help >/dev/null
        )
        rm -rf "$smoke_root"
        echo "  OMEGA core registration verified: $OUTPUT_DIR/$host_platform/$host_exe"
    else
        echo "  Skipped: host platform ($host_platform) is not among the build targets."
        echo "  Non-host targets must be tested on a matching machine (chmod +x omega for unix)."
    fi
else
    echo "==> Skipping smoke test (--skip-smoke-test)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==> Build complete!"
echo "Archives available in $OUTPUT_DIR/"
ls -lh "$OUTPUT_DIR"/*.tar.gz "$OUTPUT_DIR"/*.zip 2>/dev/null || true
echo ""
echo "Executables for testing:"
for platform in "${PLATFORMS[@]}"; do
    if is_windows_platform "$platform"; then
        echo "  $OUTPUT_DIR/$platform/omega.exe"
    else
        echo "  $OUTPUT_DIR/$platform/omega"
    fi
done
