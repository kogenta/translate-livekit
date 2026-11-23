@echo off
rem Double-click to stop Live Translate.
cd /d "%~dp0"
docker compose down
timeout /t 5 >nul
