# InariWatch CLI — Windows Installer
# Usage: irm https://get.inariwatch.com/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$Repo   = "orbita-pos/inariwatch"
$BinDir = "$HOME\.inariwatch\bin"
$Bin    = "$BinDir\inariwatch.exe"

Write-Host "Installing InariWatch CLI for Windows..." -ForegroundColor Cyan

# Fetch latest release info
$Release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
$Version = $Release.tag_name
Write-Host "  Version : $Version" -ForegroundColor Gray

# Download binary
$Url = "https://github.com/$Repo/releases/latest/download/inariwatch-windows-x86_64.exe"
Write-Host "  From    : $Url" -ForegroundColor Gray

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Invoke-WebRequest -Uri $Url -OutFile $Bin -UseBasicParsing

# Add to user PATH if not already present
$UserPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $UserPath) { $UserPath = "" }
if ($UserPath -notlike "*$BinDir*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$UserPath;$BinDir", "User")
    Write-Host "  PATH    : added $BinDir" -ForegroundColor Gray
}

Write-Host ""
Write-Host "  Installed $Version to $Bin" -ForegroundColor Green
Write-Host ""
Write-Host "  Restart your terminal, then run:" -ForegroundColor White
Write-Host "    inariwatch --help" -ForegroundColor Cyan
Write-Host ""
