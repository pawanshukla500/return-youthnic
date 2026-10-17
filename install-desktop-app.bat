@echo off
setlocal
title Return App - 24/7 Claim Bot Installer
cd /d "%~dp0"

echo ======================================================================
echo   Return App · 24/7 Claim Bot Installer
echo   Automated Meesho Claims & Assisted Marketplace Evidence Engine
echo ======================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed on this PC.
  echo Please download and install Node.js LTS from https://nodejs.org
  echo After installing Node.js, run this file again.
  echo.
  pause
  exit /b 1
)

echo [1/3] Node.js detected:
node -v
echo.

echo [2/3] Installing and verifying required packages...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install encountered an error. Please check your internet connection.
  pause
  exit /b 1
)
echo Packages installed successfully!
echo.

echo [3/3] Creating Windows Desktop shortcut for 24/7 Bot...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell; " ^
  "$desktop = [Environment]::GetFolderPath('Desktop'); " ^
  "$s = $ws.CreateShortcut(\"$desktop\Return App Claim Bot.lnk\"); " ^
  "$s.TargetPath = '%~dp0START-BOT.bat'; " ^
  "$s.WorkingDirectory = '%~dp0'; " ^
  "$s.Description = 'Return App 24/7 claim bot'; " ^
  "$s.Save(); " ^
  "Write-Host 'Desktop shortcut created on your Desktop!'"

echo.
echo ======================================================================
echo   Installation Complete!
echo   Launching the 24/7 Desktop Claim Bot Dashboard...
echo ======================================================================
echo.

call START-BOT.bat
