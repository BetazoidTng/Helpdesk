#!/usr/bin/env bash
# Recreates the local development setup from scratch: starts the local SQL
# Server container, installs dependencies, creates .env if it doesn't exist
# yet, and builds the database. Safe to re-run any time -- it never drops
# or wipes an existing database, and never overwrites an existing .env.
#
# Usage:
#   ./scripts/setup-dev.sh
#
# This is for local development on your own machine (matches
# docker-compose.yml). For a Windows Server production box, use
# scripts/setup-windows-server.ps1 instead -- see README.md.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== Helpdesk: local dev setup =="

if ! command -v node >/dev/null 2>&1; then
    echo "Node.js isn't installed. Install it from https://nodejs.org (or via nvm/homebrew) and re-run this script." >&2
    exit 1
fi
echo "-> Node.js: $(node --version)"

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop) and re-run this script." >&2
    exit 1
fi

echo "-> Starting local SQL Server (Docker)..."
docker compose up -d

echo "-> Waiting for SQL Server to accept connections (this can take ~30-60s on first run)..."
attempts=0
until docker compose exec -T sqlserver /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "Helpdesk!2024" -C -Q "SELECT 1" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 30 ]; then
        echo "SQL Server didn't become ready in time. Check 'docker compose logs sqlserver' and try again." >&2
        exit 1
    fi
    sleep 2
done
echo "-> SQL Server is up."

echo "-> Installing npm dependencies..."
npm install

if [ ! -f .env ]; then
    echo "-> Creating .env from .env.example..."
    cp .env.example .env
    # Give it a real random session secret instead of the placeholder, so
    # nobody accidentally ships "change-this-to-something-random" to prod.
    SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/SESSION_SECRET=change-this-to-something-random/SESSION_SECRET=${SECRET}/" .env
    else
        sed -i "s/SESSION_SECRET=change-this-to-something-random/SESSION_SECRET=${SECRET}/" .env
    fi
else
    echo "-> .env already exists -- leaving it untouched."
fi

echo "-> Creating/updating database tables (safe to re-run -- never drops data)..."
npm run init-db

echo ""
echo "All set. Start the app with:"
echo "    npm start        (or: npm run dev, to auto-restart on file changes)"
echo ""
echo "Then open http://localhost:\$(grep '^PORT=' .env | cut -d= -f2 || echo 3200)"
echo "On a brand-new database you'll land on /setup.html to create the first Admin account."
echo "Email-to-ticket (IMAP) and outbound notifications stay off until you fill in the"
echo "SMTP_*/IMAP_* settings in .env -- everything else works without them."
