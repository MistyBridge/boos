# stop-old.ps1 — graceful shutdown of existing BOOS instances
# Called from start.bat. Scans known ports, sends /api/shutdown, waits for exit.

$ports = @(7780, 7777, 7781, 7782, 7783, 7784, 7785, 7786)

foreach ($p in $ports) {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$p/api/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
    if ($r.StatusCode -eq 200) {
      Write-Host "  Found BOOS on port $p - shutting down..."
      try {
        Invoke-WebRequest -Method POST -Uri "http://localhost:$p/api/shutdown" -TimeoutSec 5 -UseBasicParsing | Out-Null
      } catch {
        # shutdown endpoint may already be down
      }
      Start-Sleep -Seconds 2

      # Wait for port to free (up to 15s)
      $waited = 0
      while ($waited -lt 15) {
        try {
          Invoke-WebRequest -Uri "http://localhost:$p/api/health" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop | Out-Null
        } catch {
          break
        }
        Start-Sleep -Seconds 1
        $waited++
      }
      Write-Host "  Old server stopped."
      break
    }
  } catch {
    # port not running BOOS, skip
    continue
  }
}
