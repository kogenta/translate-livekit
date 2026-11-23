@echo off
rem Double-click to start Live Translate (LiveKit + app) with Docker Desktop.
cd /d "%~dp0"

if not exist ".env.local" (
  echo Missing .env.local next to this file.
  echo Create it with one line:  GEMINI_API_KEY=your-key
  pause
  exit /b 1
)

docker info >nul 2>&1
if not errorlevel 1 goto docker_ready

echo Starting Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set /a tries=0
:wait_docker
timeout /t 3 /nobreak >nul
docker info >nul 2>&1
if not errorlevel 1 goto docker_ready
set /a tries+=1
if %tries% lss 60 goto wait_docker
echo Docker Desktop did not start. Open it manually, wait for "Engine running", then run this again.
pause
exit /b 1

:docker_ready
echo Starting Live Translate. The first run builds the image and takes a few minutes...
docker compose up -d --build
if errorlevel 1 (
  echo Failed to start. See the messages above.
  pause
  exit /b 1
)

echo Waiting for the app...
set /a tries=0
:wait_app
curl -s -o nul http://localhost:3000/ && goto app_ready
set /a tries+=1
if %tries% geq 30 goto app_ready
timeout /t 2 /nobreak >nul
goto wait_app

:app_ready
start "" http://localhost:3000
echo Live Translate is running at http://localhost:3000  (stop it with stop.cmd)
timeout /t 5 >nul
