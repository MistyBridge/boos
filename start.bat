@echo off
setlocal
title BOOS Dashboard (Dev)
set "BOOS_HOME=%CD%\.boos-data"
cd /d "%CD%"
node "%~dp0scripts\dev-launcher.js" %CD%
pause
