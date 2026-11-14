# Makes Margin.zip to give to a friend: the app (none of your books or notes) plus a double-click
# installer. Re-run after changes to share the newest version.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build.ps1')
$stage = Join-Path $PSScriptRoot 'build-share'
$zip   = Join-Path $PSScriptRoot 'Margin.zip'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
$app = Join-Path $stage 'Margin\app'
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'build\*') $app -Recurse
Copy-Item (Join-Path $PSScriptRoot 'share\*') (Join-Path $stage 'Margin')
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage 'Margin') -DestinationPath $zip
Remove-Item $stage -Recurse -Force
Write-Host "Made $zip ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)"
