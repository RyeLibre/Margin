# Installs Margin for this Windows user: copies it to %LOCALAPPDATA%\Programs\Margin,
# adds Desktop + Start menu shortcuts and opens it. Nothing needs admin rights.
$ErrorActionPreference = 'Stop'
$src  = Join-Path $PSScriptRoot 'app'
$dest = Join-Path $env:LOCALAPPDATA 'Programs\Margin'

# Margin draws its window with Microsoft Edge WebView2, which Windows 11 (and most Windows 10 PCs) already have
$wv = 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$hasWebView = (Test-Path "HKLM:\SOFTWARE\WOW6432Node\$($wv.Substring(9))") -or (Test-Path "HKLM:\$wv") -or (Test-Path "HKCU:\$wv")
if (-not $hasWebView) {
  Add-Type -AssemblyName System.Windows.Forms
  $r = [System.Windows.Forms.MessageBox]::Show("Margin needs the Microsoft Edge WebView2 Runtime, which isn't on this PC yet.`n`nOpen Microsoft's download page now? Install it, then run 'Install Margin' again.", 'Margin', 'YesNo', 'Information')
  if ($r -eq 'Yes') { Start-Process 'https://developer.microsoft.com/microsoft-edge/webview2/#download' }
  exit 1
}

New-Item -ItemType Directory -Force $dest | Out-Null
# close Margin if it's open, so its files can be replaced (an update keeps your books and notes)
Get-Process Margin -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq (Join-Path $dest 'Margin.exe') } | ForEach-Object {
  $_.CloseMainWindow() | Out-Null
  if (-not $_.WaitForExit(5000)) { $_.Kill() }
}
if (Test-Path (Join-Path $dest 'web')) { Remove-Item (Join-Path $dest 'web') -Recurse -Force }
Copy-Item (Join-Path $src '*') $dest -Recurse -Force
Get-ChildItem $dest -File -Recurse | Unblock-File   # files from a downloaded zip are marked "from the internet"

$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Margin.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Margin.lnk')) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = Join-Path $dest 'Margin.exe'
  $s.IconLocation = "$(Join-Path $dest 'Margin.exe'),0"
  $s.WorkingDirectory = $dest
  $s.Description = 'Margin - read, mark up and listen to PDF and EPUB books'
  $s.Save()
}
Start-Process (Join-Path $dest 'Margin.exe')
