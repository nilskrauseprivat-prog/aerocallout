# AeroCallout - minimal local web server (no installation required)
# Usage: powershell -ExecutionPolicy Bypass -File server.ps1 [-Port 8787] [-NoBrowser]
param([int]$Port = 8787, [switch]$NoBrowser)

$root = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
# Try the requested port first, then the next ones (in case it is already in use).
$listener = $null
foreach ($p in $Port..($Port + 20)) {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    try {
        $l.Start()
        $listener = $l
        $Port = $p
        break
    } catch {
        $l.Close()
        Write-Host "Port $p belegt, versuche naechsten ..." -ForegroundColor DarkYellow
    }
}
if (-not $listener) {
    Write-Host "Kein freier Port zwischen $Port und $($Port + 20) gefunden." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  AeroCallout laeuft auf  http://localhost:$Port/" -ForegroundColor Green
Write-Host "  Fenster schliessen oder Strg+C zum Beenden."
Write-Host ""
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.webmanifest' = 'application/manifest+json'
    '.png' = 'image/png'
    '.svg' = 'image/svg+xml'
    '.ico' = 'image/x-icon'
    '.md' = 'text/plain; charset=utf-8'
}

# Proxy for ADS-B APIs that do not send CORS headers (only these hosts, only simple GET paths).
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$proxyMap = @{
    'adsblol' = 'https://api.adsb.lol'
    'adsbfi'  = 'https://opendata.adsb.fi/api'
}

function Send-Proxy($ctx, $rel) {
    $parts = $rel.Substring(6).Split('/', 2)
    $base = $proxyMap[$parts[0]]
    if (-not $base -or $parts.Length -ne 2 -or $parts[1] -notmatch '^[A-Za-z0-9/._-]+$') {
        $ctx.Response.StatusCode = 404
        return
    }
    $req = [System.Net.HttpWebRequest]::Create("$base/$($parts[1])")
    $req.UserAgent = 'AeroCallout/0.2 (open-source traffic awareness; local proxy)'
    $req.Timeout = 7000
    $req.ReadWriteTimeout = 7000
    $req.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    try {
        $resp = $req.GetResponse()
        $ms = New-Object System.IO.MemoryStream
        $resp.GetResponseStream().CopyTo($ms)
        $resp.Close()
        $bytes = $ms.ToArray()
        $ctx.Response.StatusCode = 200
        $ctx.Response.ContentType = 'application/json; charset=utf-8'
        $ctx.Response.Headers.Add('Cache-Control', 'no-store')
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch [System.Net.WebException] {
        $code = 502
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        $ctx.Response.StatusCode = $code
    }
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        try {
            $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
            if ($rel.StartsWith('proxy/')) { Send-Proxy $ctx $rel; continue }
            if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
            $file = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
            if (-not $file.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
                $ctx.Response.StatusCode = 404
            } else {
                $bytes = [System.IO.File]::ReadAllBytes($file)
                $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
                $type = $mime[$ext]
                if (-not $type) { $type = 'application/octet-stream' }
                $ctx.Response.ContentType = $type
                $ctx.Response.Headers.Add('Cache-Control', 'no-cache')
                $ctx.Response.ContentLength64 = $bytes.Length
                $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            try { $ctx.Response.StatusCode = 500 } catch {}
        } finally {
            try { $ctx.Response.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
}
