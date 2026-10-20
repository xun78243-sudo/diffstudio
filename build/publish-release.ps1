# Manually publish DiffStudio to a GitHub Release.
#
# Prerequisite: commits and tag are already pushed (tag -> v0.1.1).
#
# Run from the repo root (C:\Users\14710\Documents\Default Project):
#   $env:GITHUB_TOKEN = "<PAT with repo scope>"
#   .\build\publish-release.ps1
#
# Without GITHUB_TOKEN the script prompts for it (input is hidden).
# The token is never written to disk or to git config.

param(
  [string]$Owner = "xun78243-sudo",
  [string]$Repo  = "diffstudio",
  [string]$Tag   = "v0.1.1",
  [string]$Installer = "dist\DiffStudio-Setup-0.1.1.exe"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer (run 'npm run dist' first)" }

$token = $env:GITHUB_TOKEN
if (-not $token) {
  $secure = Read-Host "GitHub PAT" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "diffstudio-release"
}

$bodyPath = Join-Path $PSScriptRoot "release-body.md"
# Read as UTF-8 regardless of the console code page; trailing BOM is stripped by Windows PowerShell 5.
$releaseBody = [System.IO.File]::ReadAllText($bodyPath, [System.Text.Encoding]::UTF8)
$title = "DiffStudio " + ($Tag -replace '^v', '')
$json = @{ tag_name = $Tag; name = $title; body = $releaseBody; draft = $false; prerelease = $false } | ConvertTo-Json
$jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($json)

Write-Host "Creating release $Tag ..."
$release = Invoke-RestMethod -Method Post `
  -Uri "https://api.github.com/repos/$Owner/$Repo/releases" `
  -Headers $headers -ContentType "application/json; charset=utf-8" -Body $jsonBytes
Write-Host "Release created: $($release.html_url)"

$file = Get-Item $Installer
$name = $file.Name
Write-Host "Uploading $name ($([math]::Round($file.Length / 1MB, 1)) MB) ..."
$upload = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($name))"
$asset = Invoke-RestMethod -Method Post -Uri $upload -Headers $headers `
  -ContentType "application/octet-stream" -InFile $file.FullName
Write-Host "Asset uploaded: $($asset.browser_download_url)"

Write-Host "SHA256 (must match the release notes):"
(Get-FileHash $file.FullName -Algorithm SHA256).Hash
