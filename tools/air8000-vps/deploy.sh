#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then echo "Docker is required. Install Docker Engine and Compose first."; exit 1; fi
if [ ! -f .env ]; then cp .env.example .env; echo "Created .env. Edit DOMAIN, ADMIN_TOKEN and DEVICE_REGISTRY_JSON, then run this script again."; exit 2; fi
chmod 600 .env
docker compose up -d --build
echo "AirSIM VPS gateway is running. HTTPS will be issued by Caddy for the DOMAIN in .env."
