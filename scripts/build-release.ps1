$ErrorActionPreference = "Stop"

# Local full release build helper.
# Mirrors the CI order so maintenance-helper.exe is always prepared
# before the Tauri/NSIS build consumes src-tauri/resources/maintenance-helper.exe.

$repoRoot = Split-Path -Parent $PSScriptRoot
$maintenanceHelperDir = Join-Path $repoRoot "maintenance-helper"
$maintenanceHelperExe = Join-Path $repoRoot "maintenance-helper\target\release\maintenance-helper.exe"
$tauriResourcesDir = Join-Path $repoRoot "src-tauri\resources"
$tauriResourceHelperExe = Join-Path $tauriResourcesDir "maintenance-helper.exe"
$nsisBundleGlob = Join-Path $repoRoot "src-tauri\target\release\bundle\nsis\Noten_*_x64-setup.exe"
$payloadPath = Join-Path $repoRoot "bootstrapper\assets\nsis-payload.exe"
$bootstrapperDir = Join-Path $repoRoot "bootstrapper"
$bootstrapperExe = Join-Path $repoRoot "bootstrapper\target\release\noten-setup.exe"
$distDir = Join-Path $repoRoot "dist"
$distExe = Join-Path $distDir "Noten-Setup.exe"

Write-Host "[1/6] Building maintenance-helper..."
Push-Location $maintenanceHelperDir
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) {
    throw "maintenance-helper cargo build failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "[2/6] Copying maintenance-helper into Tauri resources..."
if (-not (Test-Path -LiteralPath $maintenanceHelperExe)) {
  throw "maintenance-helper executable not found: $maintenanceHelperExe"
}

New-Item -ItemType Directory -Path $tauriResourcesDir -Force | Out-Null
Copy-Item -LiteralPath $maintenanceHelperExe -Destination $tauriResourceHelperExe -Force

Write-Host "[3/6] Building Tauri app..."
Push-Location $repoRoot
try {
  npm run tauri -- build
  if ($LASTEXITCODE -ne 0) {
    throw "tauri build failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "[4/6] Copying NSIS bundle into bootstrapper assets..."
$nsisBundle = Get-ChildItem $nsisBundleGlob |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $nsisBundle) {
  throw "NSIS bundle not found under src-tauri\target\release\bundle\nsis"
}

Copy-Item -LiteralPath $nsisBundle -Destination $payloadPath -Force

Write-Host "[5/6] Building bootstrapper in release mode..."
Push-Location $bootstrapperDir
try {
  cargo build --release
  if ($LASTEXITCODE -ne 0) {
    throw "bootstrapper cargo build failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "[6/6] Copying final bootstrapper to dist..."
if (-not (Test-Path -LiteralPath $bootstrapperExe)) {
  throw "Bootstrapper executable not found: $bootstrapperExe"
}

if (-not (Test-Path -LiteralPath $distDir)) {
  New-Item -ItemType Directory -Path $distDir | Out-Null
}

Copy-Item -LiteralPath $bootstrapperExe -Destination $distExe -Force
Write-Host "Done: $distExe"
