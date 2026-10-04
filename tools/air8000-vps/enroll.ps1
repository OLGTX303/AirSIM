param(
  [Parameter(Mandatory=$true)][string]$EnrollUrl,
  [Parameter(Mandatory=$true)][string]$DeviceId,
  [Parameter(Mandatory=$true)][string]$SerialNumber,
  [Parameter(Mandatory=$true)][string]$Imei,
  [string]$OutputDirectory = ".\air8000-$DeviceId"
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) { throw "OpenSSL is required on Windows." }
$tokenSecure = Read-Host "One-time enrollment token" -AsSecureString
$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($tokenSecure)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$key = Join-Path $OutputDirectory "device.key"
$csr = Join-Path $OutputDirectory "device.csr"
& openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out $key
& openssl req -new -key $key -out $csr -subj "/CN=$DeviceId"
if ($LASTEXITCODE -ne 0) { throw "OpenSSL could not create the device CSR." }

$request = @{
  enrollment_token = $token
  device_id = $DeviceId
  serial_number = $SerialNumber
  imei = $Imei
  csr = Get-Content -Raw -LiteralPath $csr
} | ConvertTo-Json -Compress
$response = Invoke-RestMethod -Method Post -Uri ($EnrollUrl.TrimEnd('/') + "/api/enroll") -ContentType "application/json" -Body $request
$response.certificate | Set-Content -NoNewline -LiteralPath (Join-Path $OutputDirectory "device.crt")
$response.ca_certificate | Set-Content -NoNewline -LiteralPath (Join-Path $OutputDirectory "device-ca.pem")
Remove-Item -Force -LiteralPath $csr
Write-Host "Enrollment complete. Keep device.key private; provision device.key, device.crt, and device-ca.pem on the Air8000."
