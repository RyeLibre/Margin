# Margin Reader - tiny local web server (no install needed).
# Serves this folder at http://localhost:8765/ and opens it in your browser.
# -NoBrowser: just run the server (launch.vbs uses this and opens its own app window).
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$port = 8765
$url  = "http://localhost:$port/"

$mime = @{
  '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.mjs'='text/javascript; charset=utf-8'
  '.css'='text/css; charset=utf-8'; '.json'='application/json'; '.webmanifest'='application/manifest+json'
  '.svg'='image/svg+xml'; '.png'='image/png'; '.wasm'='application/wasm'; '.bcmap'='application/octet-stream'
  '.pfb'='application/octet-stream'; '.ttf'='font/ttf'; '.txt'='text/plain; charset=utf-8'; '.map'='application/json'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
try { $listener.Start() }
catch {
  if ($NoBrowser) { exit }
  Write-Host "Margin seems to be running already (port $port is in use). Opening it..."
  Start-Process $url
  Start-Sleep -Seconds 3
  exit
}

if (-not $NoBrowser) {
  Write-Host ""
  Write-Host "  Margin Reader is running at $url"
  Write-Host "  Keep this window open while you read. Close it to stop."
  Write-Host ""
  Start-Process $url
}

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  $res = $ctx.Response
  try {
    $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/') -replace '/', '\')))
    if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $type = $mime[$ext]; if (-not $type) { $type = 'application/octet-stream' }
      $res.ContentType = $type
      $res.Headers.Add('Cache-Control', 'no-cache')
      # lets the voice engine use several CPU cores (much faster)
      $res.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin')
      $res.Headers.Add('Cross-Origin-Embedder-Policy', 'credentialless')
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes('Not found')
      $res.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
