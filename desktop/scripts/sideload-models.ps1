# sideload-models.ps1 -- stage a GGUF into the Inari Live local model cache
#
# Verifies the file's BLAKE3 against the in-binary catalogue
# (src-tauri/src/local_ai/registry.rs::catalogue) and copies it to the
# canonical path the runtime resolves at first generate() call:
#
#   %LOCALAPPDATA%\com.inariwatch.desktop\inari-live\models\<model_id>\<hash>.gguf
#
# llama-server.exe + DLLs are sideloaded separately to:
#
#   %LOCALAPPDATA%\com.inariwatch.desktop\inari-live\bin\
#
# This script handles ONLY GGUF placement, not the sidecar binary. The
# binary is copied once during Inari Live install (or by the bundled
# tauri.conf.json bundle.resources entry once S32 lands).
#
# Usage:
#   .\sideload-models.ps1 -Gguf "D:\downloads\Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf" -ModelId "qwen2.5-coder-1.5b"
#   .\sideload-models.ps1 -List              # show what's installed
#
# Requires: b3sum.exe on PATH (`cargo install b3sum`).

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install', Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$Gguf,

    [Parameter(ParameterSetName = 'Install', Mandatory = $true)]
    [ValidateSet('qwen2.5-coder-0.5b', 'qwen2.5-coder-1.5b', 'kortix-fast-apply-7b')]
    [string]$ModelId,

    [Parameter(ParameterSetName = 'List')]
    [switch]$List
)

$ErrorActionPreference = 'Stop'

# Catalogue mirror -- keep in lockstep with src-tauri/src/local_ai/registry.rs::catalogue().
# Hashes lifted at sideload time and verified against b3sum on this machine.
# The 0.5B fallback row stays a placeholder until a future session lands a real digest.
$Catalogue = @{
    'qwen2.5-coder-0.5b' = @{
        Hash      = ('0' * 64)
        SizeBytes = 419430400
        Display   = 'Qwen2.5-Coder 0.5B (fallback)'
    }
    'qwen2.5-coder-1.5b' = @{
        Hash      = '117fd82563e7bb5d49ae7a247787177657c0a56cfbf204af18638c59e5719897'
        SizeBytes = 986048800
        Display   = 'Qwen2.5-Coder 1.5B (Tab)'
    }
    'kortix-fast-apply-7b' = @{
        Hash      = '8ec091271467d3834aad84136a53be8f262f5665f1aff800c773f1323f3593c8'
        SizeBytes = 4683072224
        Display   = 'Kortix FastApply 7B (Apply)'
    }
}

$ModelsRoot = Join-Path $env:LOCALAPPDATA 'com.inariwatch.desktop\inari-live\models'
$BinRoot    = Join-Path $env:LOCALAPPDATA 'com.inariwatch.desktop\inari-live\bin'

function Show-Installed {
    Write-Host "models root: $ModelsRoot" -ForegroundColor Cyan
    Write-Host "sidecar bin: $BinRoot"   -ForegroundColor Cyan
    $llamaExe = Join-Path $BinRoot 'llama-server.exe'
    if (Test-Path $llamaExe) { $llamaState = 'present' } else { $llamaState = 'MISSING' }
    Write-Host ("llama-server.exe: {0}" -f $llamaState)
    Write-Host ''

    foreach ($id in ($Catalogue.Keys | Sort-Object)) {
        $spec = $Catalogue[$id]
        $expected = Join-Path $ModelsRoot "$id\$($spec.Hash).gguf"
        if (Test-Path $expected) {
            $actualSize = (Get-Item $expected).Length
            if ($actualSize -eq $spec.SizeBytes) { $matchSize = 'ok' } else { $matchSize = "MISMATCH (got $actualSize)" }
            Write-Host ("[installed] {0,-25} {1,8:N0} MB  size={2}" -f $id, ($actualSize / 1MB), $matchSize)
        } else {
            Write-Host ("[missing  ] {0,-25} {1,8:N0} MB  ({2})" -f $id, ($spec.SizeBytes / 1MB), $spec.Display)
        }
    }
}

if ($PSCmdlet.ParameterSetName -eq 'List') {
    Show-Installed
    return
}

# Install path

if (-not (Get-Command b3sum -ErrorAction SilentlyContinue)) {
    throw "b3sum.exe not found on PATH. Install with: cargo install b3sum"
}

$spec = $Catalogue[$ModelId]
$srcBytes = (Get-Item $Gguf).Length
Write-Host ("source: {0} ({1:N0} bytes)" -f $Gguf, $srcBytes) -ForegroundColor Cyan

if ($srcBytes -ne $spec.SizeBytes) {
    Write-Warning ("size mismatch: got {0:N0}, expected {1:N0}" -f $srcBytes, $spec.SizeBytes)
}

Write-Host "computing BLAKE3..."
$hashLine = & b3sum --no-names $Gguf
if ($LASTEXITCODE -ne 0) { throw "b3sum failed (exit $LASTEXITCODE)" }
$hash = $hashLine.Trim().ToLowerInvariant()
Write-Host ("blake3:   {0}" -f $hash)
Write-Host ("expected: {0}" -f $spec.Hash)

if ($hash -ne $spec.Hash) {
    if ($spec.Hash -eq ('0' * 64)) {
        throw "catalogue hash for $ModelId is still the S21 placeholder. Update src-tauri/src/local_ai/registry.rs::catalogue() first, then re-run."
    }
    throw "BLAKE3 mismatch -- refusing to install."
}

$destDir  = Join-Path $ModelsRoot $ModelId
$destPath = Join-Path $destDir   "$($spec.Hash).gguf"
New-Item -ItemType Directory -Path $destDir -Force | Out-Null

if (Test-Path $destPath) {
    Write-Host "already installed at $destPath -- replacing"
    Remove-Item $destPath -Force
}

Write-Host "copying to $destPath ..."
Copy-Item $Gguf $destPath
Write-Host "ok." -ForegroundColor Green
Write-Host ''
Show-Installed
