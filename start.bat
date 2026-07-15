@echo off
title BOOS Dashboard (dev)
cd /d "%~dp0"

REM ── dev mode: serve frontend from public/, hot-reload enabled ──
set "BOOS_DEV=1"
set "BOOS_KEEP_ALIVE=1"

REM ── read port from config ──
set "BOOS_PORT=7780"
if exist "%~dp0.boos-data\config.json" (
  for /f "tokens=2 delims=:, " %%a in ('powershell -NoProfile -Command "(Get-Content '%~dp0.boos-data\config.json' -Raw | ConvertFrom-Json).port" 2^>nul') do set "BOOS_PORT=%%a"
)
set "BOOS_PORT=%BOOS_PORT: =%"

echo ==========================================
echo   BOOS Dashboard  v1.0.1  (dev mode)
echo   http://localhost:%BOOS_PORT%/
echo ==========================================
echo.

REM ── graceful shutdown of existing BOOS instance ──
echo [boot] Stopping old BOOS instances (if any)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ports = @(7780,7777,7778,7779,7781,7782,7783,7784,7785,7786); "^
  "foreach($p in $ports) { "^
    "try { "^
      "$r = Invoke-WebRequest -Uri \"http://localhost:$p/api/health\" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop; "^
      "if($r.StatusCode -eq 200) { "^
        "Write-Host \"  Found BOOS on port $p - shutting down...\"; "^
        "try { Invoke-WebRequest -Method POST -Uri \"http://localhost:$p/api/shutdown\" -TimeoutSec 5 -UseBasicParsing ^| Out-Null } catch {}; "^
        "Start-Sleep -Seconds 2; "^
        "$waited = 0; "^
        "while($waited -lt 15) { "^
          "try { Invoke-WebRequest -Uri \"http://localhost:$p/api/health\" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop ^| Out-Null } catch { break }; "^
          "Start-Sleep -Seconds 1; $waited++ "^
        "}; "^
        "Write-Host \"  Old server stopped.\"; break "^
      "} "^
    "} catch { continue } "^
  "}"

echo.
echo [boot] Starting BOOS server...
echo [boot] Press Ctrl+C to stop, or close this window.
echo ==========================================
echo.

REM ── open browser after a short delay to let server start ──
start "" /B powershell -NoProfile -Command ^
  "Start-Sleep -Seconds 3; "^
  "$port = '%BOOS_PORT%'; "^
  "for ($i = 0; $i -lt 20; $i++) { "^
    "try { $r = Invoke-WebRequest -Uri \"http://localhost:$port/api/health\" -TimeoutSec 2 -UseBasicParsing; "^
    "if ($r.StatusCode -eq 200) { Start-Process \"http://localhost:$port/\"; exit 0 } } catch { Start-Sleep -Seconds 1 } "^
  "}"

REM ── foreground: run the server ──
node server.js

REM ── server exited ──
echo.
echo [boot] Server stopped.
pause
