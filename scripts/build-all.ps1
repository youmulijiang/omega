#Requires -Version 7.0
<#
.SYNOPSIS
    Build omega binaries for all common platforms locally (Windows host).
    Superset of scripts/build-windows.ps1 and scripts/build-arm.ps1.

.DESCRIPTION
    Cross-compiles omega for darwin-arm64, darwin-x64, linux-arm64, linux-x64,
    windows-x64 and windows-arm64 using Bun, bundles all required assets, and
    packages each platform into an archive:
      - windows-*  -> omega-<platform>.zip
      - others     -> omega-<platform>.tar.gz (wrapper directory "omega")

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
    Build only for the specified platform. Valid values: darwin-arm64, darwin-x64,
    linux-arm64, linux-x64, windows-x64, windows-arm64. Defaults to all platforms.

.PARAMETER OutDir
    Output directory. Defaults to <repo-root>/out.

.PARAMETER SkipSmokeTest
    Skip running the host-compatible executable after extracting the archive.

.EXAMPLE
    .\scripts\build-all.ps1
    .\scripts\build-all.ps1 -Platform linux-arm64
    .\scripts\build-all.ps1 -SkipInstall -SkipBuild -Platform windows-x64
#>

param(
    [switch]$SkipInstall,
    [switch]$CleanInstall,
    [switch]$SkipDeps,
    [switch]$SkipBuild,
    [switch]$OfflineModelData,
    [switch]$SkipSmokeTest,
    [ValidateSet('darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64', 'windows-arm64', '')]
    [string]$Platform = '',
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
        Die "Cannot remove $description '$path'. Stop any omega process using this output and retry. $($_.Exception.Message)"
    }
}

function Test-WindowsPlatform([string]$plat) { return $plat -like 'windows-*' }

# Maps a platform name to its clipboard native package and .node file.
function Get-ClipboardNative([string]$plat) {
    switch ($plat) {
        'darwin-arm64'     { @{ Package = 'clipboard-darwin-arm64';     File = 'clipboard.darwin-arm64.node' } }
        'darwin-x64'       { @{ Package = 'clipboard-darwin-x64';       File = 'clipboard.darwin-x64.node' } }
        'linux-arm64'      { @{ Package = 'clipboard-linux-arm64-gnu';  File = 'clipboard.linux-arm64-gnu.node' } }
        'linux-x64'        { @{ Package = 'clipboard-linux-x64-gnu';    File = 'clipboard.linux-x64-gnu.node' } }
        'windows-arm64'    { @{ Package = 'clipboard-win32-arm64-msvc'; File = 'clipboard.win32-arm64-msvc.node' } }
        'windows-x64'      { @{ Package = 'clipboard-win32-x64-msvc';   File = 'clipboard.win32-x64-msvc.node' } }
        default { Die "Unsupported platform: $plat" }
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
# tar (bsdtar) ships with Windows 10+ and is used for .tar.gz packaging.
Require-Command 'tar'

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
$allPlatforms = @('darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'windows-x64', 'windows-arm64')
$platforms = if ($Platform) { @($Platform) } else { $allPlatforms }

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
    Step 'Installing cross-platform native bindings...'

    $clipboardVersion = node -p "require('./packages/coding-agent/package.json').optionalDependencies['@mariozechner/clipboard']"
    if ($LASTEXITCODE -ne 0) { Die 'Failed to read clipboard version.' }

    $nativeDepsDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
    Assert-SafeChildPath $nativeDepsDir ([System.IO.Path]::GetTempPath()) 'temporary dependency directory'
    New-Item -ItemType Directory -Path $nativeDepsDir | Out-Null
    '{"private":true}' | Set-Content -Path "$nativeDepsDir/package.json" -Encoding UTF8

    try {
        $nativePackageNames = $platforms | ForEach-Object { (Get-ClipboardNative $_).Package } | Sort-Object -Unique
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
# 4. Compile binaries with Bun (cross-compile)
# ---------------------------------------------------------------------------
Step 'Compiling binaries...'
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

    if (Test-WindowsPlatform $plat) {
        $archivePath = Join-Path $OutDir "omega-$plat.zip"
    } else {
        $archivePath = Join-Path $OutDir "omega-$plat.tar.gz"
    }
    Assert-SafeChildPath $archivePath $OutDir 'platform archive'
    Remove-BuildItem $archivePath 'platform archive'
}

foreach ($plat in $platforms) {
    Write-Host "  Building $plat..." -ForegroundColor Yellow

    $bunTarget = "bun-$plat"
    if ($plat -match '-x64$') { $bunTarget = "$bunTarget-baseline" }

    $exePath = if (Test-WindowsPlatform $plat) { "$OutDir/$plat/omega.exe" } else { "$OutDir/$plat/omega" }
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
    $clip = Get-ClipboardNative $plat
    $clipDest = "$dest/node_modules/@mariozechner"
    New-Item -ItemType Directory -Force -Path $clipDest | Out-Null
    if (-not (Test-Path -LiteralPath "../../node_modules/@mariozechner/clipboard")) {
        Die 'Clipboard package is missing. Run without -SkipDeps first.'
    }
    if (-not (Test-Path -LiteralPath "../../node_modules/@mariozechner/$($clip.Package)")) {
        Die "$($clip.Package) is missing. Run without -SkipDeps first."
    }
    Copy-Item -Recurse "../../node_modules/@mariozechner/clipboard"        "$clipDest/"
    Copy-Item -Recurse "../../node_modules/@mariozechner/$($clip.Package)" "$clipDest/"
    Copy-Item "../../node_modules/@mariozechner/$($clip.Package)/$($clip.File)" `
              "$clipDest/clipboard/"

    # Platform-specific terminal native helpers
    if ($plat -like 'darwin-*') {
        $darwinHelper = "../tui/native/darwin/prebuilds/$plat/darwin-modifiers.node"
        if (Test-Path $darwinHelper) {
            $darwinDest = "$dest/native/darwin/prebuilds/$plat"
            New-Item -ItemType Directory -Force -Path $darwinDest | Out-Null
            Copy-Item $darwinHelper "$darwinDest/"
        }
    }
    if (Test-WindowsPlatform $plat) {
        $win32Arch = if ($plat -eq 'windows-arm64') { 'win32-arm64' } else { 'win32-x64' }
        $consoleSrc = "../tui/native/win32/prebuilds/$win32Arch/win32-console-mode.node"
        if (Test-Path $consoleSrc) {
            $consoleDest = "$dest/native/win32/prebuilds/$win32Arch"
            New-Item -ItemType Directory -Force -Path $consoleDest | Out-Null
            Copy-Item $consoleSrc "$consoleDest/"
        }
    }
}

# ---------------------------------------------------------------------------
# 6. Create archives
#    - windows-* -> .zip
#    - others    -> .tar.gz with a top-level "omega" wrapper directory
#      (mise compatibility, matching scripts/build-binaries.sh)
# ---------------------------------------------------------------------------
Step 'Creating archives...'
Set-Location $OutDir

foreach ($plat in $platforms) {
    if (Test-WindowsPlatform $plat) {
        $zipPath = "omega-$plat.zip"
        Write-Host "  Packing $zipPath..." -ForegroundColor Yellow
        Compress-Archive -Path "$plat/*" -DestinationPath $zipPath
        $size = (Get-Item $zipPath).Length / 1MB
        Write-Host ('  -> {0} ({1:F1} MB)' -f $zipPath, $size) -ForegroundColor Green
    } else {
        $tarPath = "omega-$plat.tar.gz"
        Write-Host "  Packing $tarPath..." -ForegroundColor Yellow
        Remove-BuildItem 'omega' 'temporary wrapper directory' -Recurse
        Move-Item -LiteralPath $plat -Destination 'omega'
        tar -czf $tarPath omega
        if ($LASTEXITCODE -ne 0) { Die "tar failed for $tarPath." }
        Move-Item -LiteralPath 'omega' -Destination $plat
        $size = (Get-Item $tarPath).Length / 1MB
        Write-Host ('  -> {0} ({1:F1} MB)' -f $tarPath, $size) -ForegroundColor Green
    }
}

# ---------------------------------------------------------------------------
# 7. Re-extract for local testing / inspection
# ---------------------------------------------------------------------------
Step 'Extracting archives...'
foreach ($plat in $platforms) {
    $platformDir = Join-Path $OutDir $plat
    Assert-SafeChildPath $platformDir $OutDir 'extracted platform directory'
    Remove-BuildItem $platformDir 'platform staging directory' -Recurse
    New-Item -ItemType Directory -Force -Path $plat | Out-Null
    if (Test-WindowsPlatform $plat) {
        Expand-Archive -Path "omega-$plat.zip" -DestinationPath $plat -Force
    } else {
        Remove-BuildItem 'omega' 'temporary wrapper directory' -Recurse
        tar -xzf "omega-$plat.tar.gz"
        if ($LASTEXITCODE -ne 0) { Die "tar extraction failed for omega-$plat.tar.gz." }
        Move-Item -LiteralPath 'omega' -Destination $plat
    }
}

# ---------------------------------------------------------------------------
# 8. Smoke test host-compatible output
# ---------------------------------------------------------------------------
if (-not $SkipSmokeTest) {
    Step 'Smoke testing host-compatible executable...'
    $hostIsWindows = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)
    $hostIsMacOS   = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)
    $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
    $suffix = if ($arch -eq 'Arm64') { 'arm64' } else { 'x64' }

    $hostPlatform = if ($hostIsWindows) { "windows-$suffix" }
                    elseif ($hostIsMacOS) { "darwin-$suffix" }
                    else { "linux-$suffix" }

    if ($platforms -contains $hostPlatform) {
        $smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
        Assert-SafeChildPath $smokeRoot ([System.IO.Path]::GetTempPath()) 'smoke-test directory'
        New-Item -ItemType Directory -Path $smokeRoot | Out-Null
        try {
            $previousAgentDir = $env:OMEGA_CODING_AGENT_DIR
            $previousOffline = $env:PI_OFFLINE
            $env:OMEGA_CODING_AGENT_DIR = Join-Path $smokeRoot 'agent'
            $env:PI_OFFLINE = '1'
            $exePath = Join-Path $OutDir "$hostPlatform/omega$($hostIsWindows ? '.exe' : '')"
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
        Write-Host "  Skipped: host platform ($hostPlatform) is not among the build targets." -ForegroundColor DarkGray
        Write-Host "  Non-host targets must be tested on a matching machine (chmod +x omega for unix)." -ForegroundColor DarkGray
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
Get-ChildItem -Path $OutDir -Include '*.zip', '*.tar.gz' -File |
    Sort-Object Name |
    Format-Table @{L='File';E={$_.Name}}, @{L='Size';E={'{0:F1} MB' -f ($_.Length/1MB)}} -AutoSize
Write-Host 'Executables for testing:' -ForegroundColor White
foreach ($plat in $platforms) {
    $exe = if (Test-WindowsPlatform $plat) { 'omega.exe' } else { 'omega' }
    Write-Host "  $OutDir\$plat\$exe"
}
