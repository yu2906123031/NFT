@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node check-nft.mjs
set "RUN_EXIT=%ERRORLEVEL%"
echo.
echo Results saved in reports. Exit code: %RUN_EXIT%
if /I not "%~1"=="--no-pause" pause
exit /b %RUN_EXIT%
