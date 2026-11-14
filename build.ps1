# Builds Margin into .\build: makes the icon, compiles Margin.exe (host\MarginHost.cs) with the
# C# compiler that ships with Windows, and puts the reader page (web\) and everything else beside it.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = $PSScriptRoot
$out  = Join-Path $root 'build'
$lib  = Join-Path $root 'host\lib'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force $out, $lib | Out-Null

# --- the WebView2 files (the same ones Shelf and LibreOS use); copied from them the first time ---
$dlls = 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll'
if (-not (Test-Path (Join-Path $lib $dlls[0]))) {
  $from = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Music Player\host\lib'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Shelf'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Libre OS\LibreOS\host\lib'),
    (Join-Path $env:LOCALAPPDATA 'Programs\LibreOS')
  ) | Where-Object { Test-Path (Join-Path $_ $dlls[0]) } | Select-Object -First 1
  if (-not $from) { throw "Margin needs $($dlls -join ', ') in host\lib (from the Microsoft.Web.WebView2 NuGet package)." }
  foreach ($d in $dlls) { Copy-Item (Join-Path $from $d) $lib -Force }
  Write-Host "Copied the WebView2 files from $from"
}

# --- icon: icon.png at 256/48/32/16 px in one .ico ---
$srcImg = [System.Drawing.Image]::FromFile((Join-Path $root 'icon.png'))
$pngs = foreach ($px in 256, 48, 32, 16) {
  $bm = New-Object System.Drawing.Bitmap $px, $px
  $gg = [System.Drawing.Graphics]::FromImage($bm)
  $gg.InterpolationMode = 'HighQualityBicubic'; $gg.SmoothingMode = 'AntiAlias'; $gg.PixelOffsetMode = 'HighQuality'
  $gg.Clear([System.Drawing.Color]::Transparent); $gg.DrawImage($srcImg, 0, 0, $px, $px); $gg.Dispose()
  $m = New-Object System.IO.MemoryStream
  if ($px -ge 256) { $bm.Save($m, [System.Drawing.Imaging.ImageFormat]::Png) }
  else {
    # small sizes: classic 32-bit bitmap (every Windows and .NET part can draw these)
    $bw = New-Object System.IO.BinaryWriter $m
    $bw.Write([UInt32]40); $bw.Write([Int32]$px); $bw.Write([Int32]($px * 2)); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]0); $bw.Write([UInt32]($px * $px * 4)); $bw.Write([Int32]0); $bw.Write([Int32]0); $bw.Write([UInt32]0); $bw.Write([UInt32]0)
    for ($y = $px - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $px; $x++) { $c = $bm.GetPixel($x, $y); $bw.Write([Byte]$c.B); $bw.Write([Byte]$c.G); $bw.Write([Byte]$c.R); $bw.Write([Byte]$c.A) } }
    $bw.Write((New-Object byte[] ([int]([math]::Ceiling($px / 32) * 4 * $px))))
    $bw.Flush()
  }
  $bm.Dispose()
  , @($px, $m.ToArray())
}
$srcImg.Dispose()
$ico = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $ico
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$pngs.Count)
$offset = 6 + 16 * $pngs.Count
foreach ($p in $pngs) {
  $d = $(if ($p[0] -ge 256) { 0 } else { $p[0] })
  $w.Write([Byte]$d); $w.Write([Byte]$d); $w.Write([Byte]0); $w.Write([Byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$p[1].Length); $w.Write([UInt32]$offset)
  $offset += $p[1].Length
}
foreach ($p in $pngs) { $w.Write($p[1]) }
$w.Flush()
$icoPath = Join-Path $out 'margin.ico'
[System.IO.File]::WriteAllBytes($icoPath, $ico.ToArray())

# --- compile Margin.exe ---
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo /target:winexe /platform:x64 /optimize+ `
  "/out:$(Join-Path $out 'Margin.exe')" "/win32icon:$icoPath" "/win32manifest:$(Join-Path $root 'host\app.manifest')" `
  "/reference:$(Join-Path $lib 'Microsoft.Web.WebView2.Core.dll')" "/reference:$(Join-Path $lib 'Microsoft.Web.WebView2.WinForms.dll')" `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  (Join-Path $root 'host\MarginHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compiling Margin.exe failed' }

# --- everything Margin.exe needs beside it ---
Copy-Item (Join-Path $lib '*.dll') $out -Force
$web = Join-Path $out 'web'
New-Item -ItemType Directory -Force $web | Out-Null
foreach ($f in 'index.html', 'app.js', 'epub.js', 'tts-worker.js', 'manifest.webmanifest', 'icon.svg', 'icon.png') { Copy-Item (Join-Path $root $f) $web -Force }
Copy-Item (Join-Path $root 'lib') $web -Recurse -Force
Write-Host "Built $(Join-Path $out 'Margin.exe')"
