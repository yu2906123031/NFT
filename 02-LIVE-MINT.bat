@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Install Node.js 22 or newer first.
  pause
  exit /b 1
)
node launch.mjs live
set "RUN_EXIT=%ERRORLEVEL%"
echo.
echo Live Mint exit code: %RUN_EXIT%. Reports are saved in reports.
if /I not "%~1"=="--no-pause" pause
exit /b %RUN_EXIT%