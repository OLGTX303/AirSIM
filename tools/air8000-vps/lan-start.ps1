param([int]$Port = 8081, [switch]$OpenLan)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 20 or newer is required." }
if (-not (Test-Path node_modules\ws)) { npm install --omit=dev }
$deviceConfig = Join-Path $PSScriptRoot "..\..\air8000\config.lua"
$secretFile = Join-Path $PSScriptRoot ".lan-secrets.json"
$newToken = {
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    return ([BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
  } finally { $rng.Dispose() }
}
if (Test-Path $secretFile) {
  $localSecrets = Get-Content -Raw -LiteralPath $secretFile | ConvertFrom-Json
  $admin = [string]$localSecrets.admin_token
} else {
  $admin = & $newToken
  @{ admin_token = $admin; created_at = (Get-Date).ToUniversalTime().ToString("o") } |
    ConvertTo-Json | Set-Content -LiteralPath $secretFile -Encoding ascii
  try { & icacls.exe $secretFile /inheritance:r /grant:r "$env:USERNAME`:(R,W)" | Out-Null } catch { }
}
$deviceId = ""
$deviceSecret = ""
$enrollment = ""
$relayHost = ""
if (Test-Path $deviceConfig) {
  $configText = Get-Content -Raw -LiteralPath $deviceConfig
  $deviceIdMatch = [regex]::Match($configText, 'device_id\s*=\s*"([^"]+)"')
  if ($deviceIdMatch.Success -and $deviceIdMatch.Groups[1].Value -notlike "REPLACE_WITH_*") { $deviceId = $deviceIdMatch.Groups[1].Value }
  $secretMatch = [regex]::Match($configText, 'device_secret\s*=\s*"([^"]+)"')
  if ($secretMatch.Success -and $secretMatch.Groups[1].Value -notlike "REPLACE_WITH_*") { $deviceSecret = $secretMatch.Groups[1].Value }
  $match = [regex]::Match($configText, 'enrollment_token\s*=\s*"([^"]+)"')
  if ($match.Success -and $match.Groups[1].Value -notlike "REPLACE_WITH_*") { $enrollment = $match.Groups[1].Value }
  $relayMatch = [regex]::Match($configText, 'relay_url\s*=\s*"[^:]+://([^/:"]+)')
  if ($relayMatch.Success) { $relayHost = $relayMatch.Groups[1].Value }
}
if ([string]::IsNullOrWhiteSpace($deviceId) -or [string]::IsNullOrWhiteSpace($enrollment)) {
  Write-Warning "air8000/config.lua still has placeholder enrollment settings. The LAN portal will start, but the device cannot auto-enroll until device_id and enrollment_token are filled."
}
$env:PORT = [string]$Port
$env:LAN_MODE = "true"
$env:ADMIN_TOKEN = $admin
$env:AUTO_ENROLL_TOKEN = if ([string]::IsNullOrWhiteSpace($enrollment)) { "" } else { $enrollment }
$env:LAN_BOOTSTRAP_ENABLED = if ([string]::IsNullOrWhiteSpace($enrollment) -and [string]::IsNullOrWhiteSpace($deviceSecret)) { "true" } else { "false" }
$env:LAN_BOOTSTRAP_DEVICE_ID = $deviceId
$registry = @{}
if (-not [string]::IsNullOrWhiteSpace($deviceId) -and -not [string]::IsNullOrWhiteSpace($deviceSecret)) {
  $registry[$deviceId] = @{ enrolled = $true; secret = $deviceSecret }
}
$env:DEVICE_REGISTRY_JSON = if ($registry.Count) { $registry | ConvertTo-Json -Compress } else { "{}" }
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' })
$ip = $null
if ($relayHost) { $ip = $addresses | Where-Object { $_.IPAddress -eq $relayHost } | Select-Object -First 1 -ExpandProperty IPAddress }
if (-not $ip) { $ip = $addresses | Where-Object { $_.IPAddress -like '192.168.1.*' } | Select-Object -First 1 -ExpandProperty IPAddress }
if (-not $ip) { $ip = $addresses | Select-Object -First 1 -ExpandProperty IPAddress }
if ([string]::IsNullOrWhiteSpace($ip)) { $ip = "localhost" }
$env:RTP_PUBLIC_HOST = $ip
$env:SIP_PORT = "5060"
$dashboardUrl = "http://localhost`:$Port/"
$lanDashboardUrl = "http://$ip`:$Port/"
Write-Host "Local dashboard (BLE enabled): $dashboardUrl"
Write-Host "LAN dashboard: http://$ip`:$Port/"
Write-Host "Air8000 URL: ws://$ip`:$Port/device"
Write-Host "Air8000 SIP: udp://$ip`:5060"
Write-Host "Credentials are loaded automatically from the local protected secrets/config files."
$openDashboard = if ($OpenLan) { $lanDashboardUrl } else { $dashboardUrl }
Start-Process "$openDashboard#token=$admin"
node server.mjs
