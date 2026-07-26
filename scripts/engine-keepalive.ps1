# Long-running supervisor: checks the settlement loop every 60s and relaunches it
# if it stopped answering. Detached from any terminal, so closing an editor or
# ending a session cannot take the payment loop down with it.
$ErrorActionPreference = "SilentlyContinue"
$root = "C:\Users\NEW USER\kiosk"
$watchdog = "$root\scripts\engine-watchdog.ps1"

while ($true) {
  $healthy = $false
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:3000/healthz" -TimeoutSec 8 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $healthy = $true }
  } catch { }

  if (-not $healthy) {
    & $watchdog
    Start-Sleep -Seconds 20
  }

  Start-Sleep -Seconds 60
}
