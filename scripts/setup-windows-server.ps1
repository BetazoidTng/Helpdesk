# Recreates the production setup from scratch on a Windows Server box:
# installs dependencies, creates .env if it doesn't exist yet, builds the
# database against the server's existing SQL Server instance, and
# (re)registers the app as a pm2 service. Safe to re-run -- it never drops
# an existing database, and never overwrites an existing .env.
#
# Usage (from an elevated PowerShell prompt, in the project folder):
#   .\scripts\setup-windows-server.ps1
#
# This is for the production server. For local development on your own
# machine, use scripts/setup-dev.sh instead -- see README.md.

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "== Helpdesk: production server setup ==" -ForegroundColor Cyan

# ---- Node.js ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js isn't installed. Install it from https://nodejs.org (LTS) and re-run this script." -ForegroundColor Red
    exit 1
}
Write-Host "-> Node.js: $(node --version)"

# ---- Dependencies ----
Write-Host "-> Installing npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { throw "npm install failed." }

# ---- .env ----
if (-not (Test-Path ".env")) {
    Write-Host "-> Creating .env from .env.example..."
    Copy-Item ".env.example" ".env"

    # Give it a real random session secret instead of the placeholder.
    $secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    (Get-Content ".env") -replace "SESSION_SECRET=change-this-to-something-random", "SESSION_SECRET=$secret" | Set-Content ".env"

    Write-Host ""
    Write-Host "IMPORTANT: open .env now and set DB_SERVER / DB_PORT / DB_USER / DB_PASSWORD" -ForegroundColor Yellow
    Write-Host "to point at this server's existing SQL Server instance before continuing." -ForegroundColor Yellow
    Write-Host "Also set NODE_ENV=production, COOKIE_SECURE=true once this is served over HTTPS," -ForegroundColor Yellow
    Write-Host "and the SMTP_*/IMAP_* settings if you want email notifications and email-to-ticket." -ForegroundColor Yellow
    Read-Host "Press Enter once .env is edited and saved, to continue"
} else {
    Write-Host "-> .env already exists -- leaving it untouched."
}

# ---- Database ----
Write-Host "-> Creating/updating database tables (safe to re-run -- never drops data)..."
npm run init-db
if ($LASTEXITCODE -ne 0) { throw "Database setup failed -- check the DB_* settings in .env." }

# ---- pm2 (keeps the app running as a background service) ----
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
    Write-Host "-> Installing pm2 globally..."
    npm install -g pm2
    npm install -g pm2-windows-startup
    pm2-startup install
}

Write-Host "-> Starting/restarting the app under pm2..."
pm2 describe helpdesk > $null 2>&1
if ($LASTEXITCODE -eq 0) {
    pm2 restart helpdesk
} else {
    pm2 start server/index.js --name helpdesk
}
pm2 save

# ---- Firewall ----
$port = (Select-String -Path ".env" -Pattern "^PORT=(\d+)").Matches.Groups[1].Value
if (-not $port) { $port = 3200 }
$ruleName = "Helpdesk ($port)"
if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    Write-Host "-> Opening port $port in Windows Firewall..."
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
} else {
    Write-Host "-> Firewall rule for port $port already exists."
}

# Also open the HTTPS port, but only once a certificate is actually
# configured -- otherwise the app isn't listening there yet and there's
# nothing to open a port to.
$sslCert = (Select-String -Path ".env" -Pattern "^SSL_CERT_PATH=(.+)" -ErrorAction SilentlyContinue)
if ($sslCert -and $sslCert.Matches.Groups[1].Value.Trim() -ne "") {
    $httpsPort = (Select-String -Path ".env" -Pattern "^HTTPS_PORT=(\d+)").Matches.Groups[1].Value
    if (-not $httpsPort) { $httpsPort = 3443 }
    $httpsRuleName = "Helpdesk HTTPS ($httpsPort)"
    if (-not (Get-NetFirewallRule -DisplayName $httpsRuleName -ErrorAction SilentlyContinue)) {
        Write-Host "-> Opening HTTPS port $httpsPort in Windows Firewall..."
        New-NetFirewallRule -DisplayName $httpsRuleName -Direction Inbound -Protocol TCP -LocalPort $httpsPort -Action Allow | Out-Null
    } else {
        Write-Host "-> Firewall rule for HTTPS port $httpsPort already exists."
    }
}

Write-Host ""
Write-Host "All set. The app is running under pm2 as 'helpdesk' on port $port." -ForegroundColor Green
Write-Host "Visit http://<this-server>:$port -- on a brand-new database you'll land on /setup.html"
Write-Host "to create the first Admin account. Useful commands: pm2 status, pm2 logs helpdesk."
Write-Host "To also serve this over HTTPS, set SSL_CERT_PATH/SSL_KEY_PATH in .env and re-run this script."
