#Requires -Version 7.0
<#
.SYNOPSIS
    Build omega Windows binaries locally.
    Mirrors scripts/build-binaries.sh (Windows-only subset).

.DESCRIPTION
    Compiles omega.exe for windows-x64 and/or windows-arm64 using Bun,
    bundles all required assets, and packages the result into a .zip archive.

.PARAMETER SkipInstall
    Skip dependency installation.

.PARAMETER CleanInstall
    Use npm ci instead of the default incremental npm install. This removes
    node_modules first and therefore requires all processes using it to stop.

.PARAMETER SkipDeps
    Skip installing cross-platform native bindings.

.PARAMETER SkipBuild
    Skip the TypeScript/package build step.

.PARAMETER OfflineModelData
    Build with bundled model data instead of refreshing it (uses npm run build:offline).

.PARAMETER Platform
    Build only for the specified platform. Valid values: windows-x64, windows-arm64.
    Defaults to windows-x64.

.PARAMETER OutDir
    Output directory. Defaults to <repo-root>/out.

.PARAMETER SkipSmokeTest
    Skip running the host-compatible executable after extracting the archive.

.EXAMPLE
    .\scripts\build-windows.ps1
    .\scripts\build-windows.ps1 -CleanInstall
    .\scripts\build-windows.ps1 -SkipInstall -SkipBuild -Platform windows-x64
    .\scripts\build-windows.ps1 -Platform windows-arm64 -OutDir C:\build\omega
#>

param(
    [switch]$SkipInstall,
    [switch]$CleanInstall,
    [switch]$SkipDeps,
    [switch]$SkipBuild,
    [switch]$OfflineModelData,
    [switch]$SkipSmokeTest,
    [ValidateSet('windows-x64', 'windows-arm64', '')]
    [string]$Platform = 'windows-x64',
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Step([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Die([string]$msg)  { Write-Error $msg; exit 1 }

function Require-Command([string]$name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Die "Required command '$name' was not found in PATH."
    }
}

function Assert-SafeChildPath([string]$path, [string]$parent, [string]$description) {
    $resolvedPath = [System.IO.Path]::GetFullPath($path).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $resolvedParent = [System.IO.Path]::GetFullPath($parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
    $prefix = "$resolvedParent$([System.IO.Path]::DirectorySeparatorChar)"
    if (-not $resolvedPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Die "Refusing to modify $description outside '$resolvedParent': $resolvedPath"
    }
}

function Remove-BuildItem([string]$path, [string]$description, [switch]$Recurse) {
    if (-not (Test-Path -LiteralPath $path)) { return }
    try {
        if ($Recurse) {
            Remove-Item -LiteralPath $path -Recurse -Force
        } else {
            Remove-Item -LiteralPath $path -Force
        }
    } catch {
        Die "Cannot remove $description '$path'. Stop any omega.exe process using this output and retry. $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# Repo root
# ---------------------------------------------------------------------------
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Require-Command 'node'
Require-Command 'npm'
Require-Command 'bun'

# ---------------------------------------------------------------------------
# Version
# ---------------------------------------------------------------------------
$omegaVersion = node -p "require('./packages/omega-core/package.json').version"
if ($LASTEXITCODE -ne 0) { Die 'Failed to read omega-core version.' }
Step "OMEGA version: $omegaVersion"

# ---------------------------------------------------------------------------
# Output directory
# ---------------------------------------------------------------------------
if (-not $OutDir) { $OutDir = 'out' }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) {
    $OutDir = Join-Path $repoRoot $OutDir
}
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if ($OutDir -eq [System.IO.Path]::GetFullPath($repoRoot)) {
    Die 'OutDir cannot be the repository root.'
}

# ---------------------------------------------------------------------------
# Platforms to build
# ---------------------------------------------------------------------------
$platforms = if ($Platform) { @($Platform) } else { @('windows-x64', 'windows-arm64') }

# ---------------------------------------------------------------------------
# 1. Dependencies
# ---------------------------------------------------------------------------
if (-not $SkipInstall) {
    if ($CleanInstall) {
        Step 'Installing dependencies from a clean tree...'
        npm ci --ignore-scripts
        if ($LASTEXITCODE -ne 0) {
            Die 'npm ci failed. Stop Node/omega processes using this repository, or retry without -CleanInstall.'
        }
    } else {
        Step 'Installing dependencies incrementally...'
        npm install --ignore-scripts
        if ($LASTEXITCODE -ne 0) {
            Die 'npm install failed. Stop processes using node_modules, or retry with -SkipInstall if dependencies are current.'
        }
    }
} else {
    Step 'Skipping dependency installation (--SkipInstall)'
}

# ---------------------------------------------------------------------------
# 2. Cross-platform native bindings (clipboard)
# ---------------------------------------------------------------------------
if (-not $SkipDeps) {
    Step 'Installing Windows native bindings...'

    $clipboardVersion = node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']"
    if ($LASTEXITCODE -ne 0) { Die 'Failed to read clipboard version.' }

    $nativeDepsDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    Assert-SafeChildPath $nativeDepsDir ([System.IO.Path]::GetTempPath()) 'temporary dependency directory'
    New-Item -ItemType Directory -Path $nativeDepsDir | Out-Null
    '{"private":true}' | Set-Content -Path "$nativeDepsDir/package.json" -Encoding UTF8

    try {
        $nativePackageNames = $platforms | ForEach-Object {
            if ($_ -eq 'windows-arm64') { 'clipboard-win32-arm64-msvc' }
            else { 'clipboard-win32-x64-msvc' }
        } | Sort-Object -Unique
        $pkgs = @("@mariozechner/clipboard@$clipboardVersion")
        $pkgs += $nativePackageNames | ForEach-Object { '@mariozechner/{0}@{1}' -f $_, $clipboardVersion }
        npm install --prefix $nativeDepsDir --include=optional --no-save --package-lock=false --force --ignore-scripts @pkgs
        if ($LASTEXITCODE -ne 0) { Die 'Failed to install native bindings.' }

        New-Item -ItemType Directory -Force -Path 'node_modules/@mariozechner' | Out-Null
        foreach ($pkg in @('clipboard') + $nativePackageNames) {
            $dest = "node_modules/@mariozechner/$pkg"
            Assert-SafeChildPath $dest (Join-Path $repoRoot 'node_modules/@mariozechner') 'workspace native dependency'
            Remove-BuildItem $dest 'workspace native dependency' -Recurse
            Copy-Item -Recurse "$nativeDepsDir/node_modules/@mariozechner/$pkg" $dest
        }
    } finally {
        Remove-Item -LiteralPath $nativeDepsDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Step 'Skipping native bindings (--SkipDeps)'
}

# ---------------------------------------------------------------------------
# 3. Package build
# ---------------------------------------------------------------------------
if (-not $SkipBuild) {
    if ($OfflineModelData) {
        Step 'Building packages with bundled model data...'
        npm run build:offline
    } else {
        Step 'Building packages...'
        npm run build
    }
    if ($LASTEXITCODE -ne 0) { Die 'Package build failed.' }
} else {
    Step 'Skipping package build (--SkipBuild)'
}

# ---------------------------------------------------------------------------
# 4. Compile exe with Bun
# ---------------------------------------------------------------------------
Step 'Compiling Windows binaries...'
$agentDir = Join-Path $repoRoot 'packages/coding-agent'
Set-Location $agentDir
$omegaEntry = Join-Path $repoRoot 'packages/omega-core/dist/bun/cli.js'
$omegaDist = Join-Path $repoRoot 'packages/omega-core/dist'
$imageWorker = Join-Path $agentDir 'src/utils/image-resize-worker.ts'

if (-not (Test-Path -LiteralPath $omegaEntry)) {
    Die "OMEGA binary entry is missing: $omegaEntry. Run without -SkipBuild first."
}

# Bun only embeds files that are part of the compile inputs. Omega loads its
# bundled prompts, agent definitions, and contract evidence through fs at
# runtime, so include those non-code resources explicitly in the executable.
$omegaAssetPaths = @(
    (Join-Path $omegaDist 'prompts'),
    (Join-Path $omegaDist 'subagents/agents'),
    (Join-Path $omegaDist 'background/core/delegate/hook-contract-evidence.json')
)
$missingOmegaAssets = @($omegaAssetPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
$omegaAssets = @($omegaAssetPaths | ForEach-Object { "--asset=$_" })

if ($missingOmegaAssets.Count -gt 0) {
    Die "OMEGA bundled assets are missing: $($missingOmegaAssets -join ', '). Run without -SkipBuild first."
}

# Clean only the requested platform outputs. Other artifacts in OutDir are preserved.
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($plat in $platforms) {
    $platformDir = Join-Path $OutDir $plat
    Assert-SafeChildPath $platformDir $OutDir 'platform output directory'
    Remove-BuildItem $platformDir 'platform output directory' -Recurse
    New-Item -ItemType Directory -Path $platformDir | Out-Null

    $archivePath = Join-Path $OutDir "omega-$plat.zip"
    Assert-SafeChildPath $archivePath $OutDir 'platform archive'
    Remove-BuildItem $archivePath 'platform archive'
}

foreach ($plat in $platforms) {
    Write-Host "  Building $plat..." -ForegroundColor Yellow

    $bunTarget = "bun-$plat"
    if ($plat -match '-x64$') { $bunTarget = "$bunTarget-baseline" }

    $exePath = "$OutDir/$plat/omega.exe"
    bun build --compile --no-compile-autoload-bunfig `
        --target=$bunTarget `
        $omegaEntry `
        $imageWorker `
        @omegaAssets `
        --outfile $exePath

    if ($LASTEXITCODE -ne 0) { Die "Bun compile failed for $plat." }
    Write-Host "  -> $exePath" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 5. Copy shared assets
# ---------------------------------------------------------------------------
Step 'Copying assets...'

foreach ($plat in $platforms) {
    $dest = "$OutDir/$plat"

    # Metadata & docs
    Copy-Item 'package.json'  "$dest/"
    npm pkg set "version=$omegaVersion" --prefix $dest | Out-Null
    foreach ($f in @('README.md', 'CHANGELOG.md')) {
        if (Test-Path $f) { Copy-Item $f "$dest/" }
    }

    # WASM
    $wasmSrc = '../../node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm'
    if (Test-Path $wasmSrc) { Copy-Item $wasmSrc "$dest/" }

    # Theme
    New-Item -ItemType Directory -Force -Path "$dest/theme" | Out-Null
    Copy-Item 'dist/modes/interactive/theme/*.json' "$dest/theme/" -ErrorAction SilentlyContinue

    # Assets
    New-Item -ItemType Directory -Force -Path "$dest/assets" | Out-Null
    Get-ChildItem 'dist/modes/interactive/assets' -ErrorAction SilentlyContinue |
        Copy-Item -Destination "$dest/assets/"

    # Export-html & docs & examples
    foreach ($dir in @('dist/core/export-html', 'docs', 'examples')) {
        if (Test-Path $dir) { Copy-Item -Recurse $dir "$dest/" }
    }

    # Clipboard native binding
    $clipNativePkg  = if ($plat -eq 'windows-arm64') { 'clipboard-win32-arm64-msvc' } else { 'clipboard-win32-x64-msvc' }
    $clipNativeFile = if ($plat -eq 'windows-arm64') { 'clipboard.win32-arm64-msvc.node' } else { 'clipboard.win32-x64-msvc.node' }

    $clipDest = "$dest/node_modules/@mariozechner"
    New-Item -ItemType Directory -Force -Path $clipDest | Out-Null
    if (-not (Test-Path -LiteralPath "../../node_modules/@mariozechner/clipboard")) {
        Die 'Clipboard package is missing. Run without -SkipDeps first.'
    }
    if (-not (Test-Path -LiteralPath "../../node_modules/@mariozechner/$clipNativePkg")) {
        Die "$clipNativePkg is missing. Run without -SkipDeps first."
    }
    Copy-Item -Recurse "../../node_modules/@mariozechner/clipboard"      "$clipDest/"
    Copy-Item -Recurse "../../node_modules/@mariozechner/$clipNativePkg" "$clipDest/"
    Copy-Item "../../node_modules/@mariozechner/$clipNativePkg/$clipNativeFile" `
              "$clipDest/clipboard/"

    # Win32 console-mode native helper
    $win32Arch = if ($plat -eq 'windows-arm64') { 'win32-arm64' } else { 'win32-x64' }
    $consoleSrc = "../tui/native/win32/prebuilds/$win32Arch/win32-console-mode.node"
    if (Test-Path $consoleSrc) {
        $consoleDest = "$dest/native/win32/prebuilds/$win32Arch"
        New-Item -ItemType Directory -Force -Path $consoleDest | Out-Null
        Copy-Item $consoleSrc "$consoleDest/"
    }
}

# ---------------------------------------------------------------------------
# 6. Create zip archives
# ---------------------------------------------------------------------------
Step 'Creating zip archives...'
Set-Location $OutDir

foreach ($plat in $platforms) {
    $zipPath = "omega-$plat.zip"
    Write-Host "  Packing $zipPath..." -ForegroundColor Yellow
    Compress-Archive -Path "$plat/*" -DestinationPath $zipPath
    $size = (Get-Item $zipPath).Length / 1MB
    Write-Host ('  -> {0} ({1:F1} MB)' -f $zipPath, $size) -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 7. Re-extract for local testing
# ---------------------------------------------------------------------------
Step 'Extracting archives for local testing...'
foreach ($plat in $platforms) {
    $platformDir = Join-Path $OutDir $plat
    Assert-SafeChildPath $platformDir $OutDir 'extracted platform directory'
    Remove-BuildItem $platformDir 'platform staging directory' -Recurse
    New-Item -ItemType Directory -Force -Path $plat | Out-Null
    Expand-Archive -Path "omega-$plat.zip" -DestinationPath $plat -Force
}

# ---------------------------------------------------------------------------
# 8. Smoke test host-compatible output
# ---------------------------------------------------------------------------
if (-not $SkipSmokeTest) {
    Step 'Smoke testing host-compatible executable...'
    $hostPlatform = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') {
        'windows-arm64'
    } else {
        'windows-x64'
    }

    if ($platforms -contains $hostPlatform) {
        $smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
        Assert-SafeChildPath $smokeRoot ([System.IO.Path]::GetTempPath()) 'smoke-test directory'
        New-Item -ItemType Directory -Path $smokeRoot | Out-Null
        try {
            $previousAgentDir = $env:OMEGA_CODING_AGENT_DIR
            $previousOffline = $env:PI_OFFLINE
            $env:OMEGA_CODING_AGENT_DIR = Join-Path $smokeRoot 'agent'
            $env:PI_OFFLINE = '1'
            $exePath = Join-Path $OutDir "$hostPlatform/omega.exe"
            & $exePath --plan --help | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Die "OMEGA core smoke test failed for $exePath."
            }
            Write-Host "  OMEGA core registration verified: $exePath" -ForegroundColor Green
        } finally {
            $env:OMEGA_CODING_AGENT_DIR = $previousAgentDir
            $env:PI_OFFLINE = $previousOffline
            Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Host "  Skipped: host architecture cannot execute requested targets." -ForegroundColor DarkGray
    }
} else {
    Step 'Skipping smoke test (--SkipSmokeTest)'
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ''
Step 'Build complete!'
Write-Host "Archives in: $OutDir" -ForegroundColor White
Get-ChildItem -Path $OutDir -Filter '*.zip' |
    Format-Table @{L='File';E={$_.Name}}, @{L='Size';E={'{0:F1} MB' -f ($_.Length/1MB)}} -AutoSize
Write-Host 'Executables for testing:' -ForegroundColor White
foreach ($plat in $platforms) {
    Write-Host "  $OutDir\$plat\omega.exe"
}
