# Installs Margin to %LOCALAPPDATA%\Programs\Margin and adds Desktop + Start menu shortcuts.
# Builds it first (build.ps1). Re-run after any change to update the installed copy;
# your books, notes and the voice (%LOCALAPPDATA%\Margin) are never touched.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'build.ps1')

$build = Join-Path $PSScriptRoot 'build'
$dest  = Join-Path $env:LOCALAPPDATA 'Programs\Margin'
New-Item -ItemType Directory -Force $dest | Out-Null

# close a running Margin so its files can be replaced
Get-Process Margin -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $dest 'Margin.exe') } | ForEach-Object {
  $_.CloseMainWindow() | Out-Null
  if (-not $_.WaitForExit(5000)) { $_.Kill() }
}
if (Test-Path (Join-Path $dest 'web')) { Remove-Item (Join-Path $dest 'web') -Recurse -Force }
Copy-Item (Join-Path $build '*') $dest -Recurse -Force

$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Margin.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Margin.lnk')) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $dest 'Margin.exe'
  $s.IconLocation = "$(Join-Path $dest 'Margin.exe'),0"
  $s.WorkingDirectory = $dest
  $s.Description = 'Margin - read, mark up and listen to PDF and EPUB books'
  $s.Save()
}
Write-Host "Installed to $dest"
Start-Process (Join-Path $dest 'Margin.exe')
