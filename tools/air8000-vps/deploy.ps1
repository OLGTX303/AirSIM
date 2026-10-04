Set-StrictMode -Version Latest
Set-Location $PSScriptRoot
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker Desktop is required." }
if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Edit .env, then run this script again."; exit 2 }
docker compose up -d --build
