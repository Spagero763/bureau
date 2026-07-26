# Restarts the payment engine if it stops answering. Runs from a scheduled task
# so an editor or terminal closing can never take the settlement loop down with it.
$ErrorActionPreference = "SilentlyContinue"
$root = "C:\Users\NEW USER\kiosk"

try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000/healthz" -TimeoutSec 8 -UseBasicParsing
  if ($r.StatusCode -eq 200) { exit 0 }
} catch { }

$env:PUBLIC_BASE_URL = "http://localhost:3000"
$env:SELF_BUY_ENABLED = "1"
$env:SELF_BUY_INTERVAL_SEC = "3"
$env:SELF_BUY_CONCURRENCY = "5"
$env:SELF_BUY_PREMIUM_EVERY = "0"
$env:SELF_BUY_REFILL_USD = "0.25"
$env:SELF_BUY_REFILL_BELOW_USD = "0.08"
$env:DESK_ENABLED = "0"
$env:PORT = "3000"

Start-Process -FilePath "node" -ArgumentList "dist/src/index.js" -WorkingDirectory $root `
  -WindowStyle Hidden -RedirectStandardOutput "$root\engine.log" `
  -RedirectStandardError "$root\engine.err.log"

Add-Content -Path "$root\watchdog.log" -Value "$(Get-Date -Format s) restarted engine" -Encoding utf8
