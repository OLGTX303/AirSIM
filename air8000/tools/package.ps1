param([string]$Output = "airsim-air8000-bundle.zip")
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
if (Test-Path $Output) { Remove-Item -LiteralPath $Output -Force }
Compress-Archive -Path (Join-Path $root "*") -DestinationPath $Output
Write-Output "Created $Output; flash with LuatTools after reviewing config.lua."
