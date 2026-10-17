@echo off
setlocal
title Return App 24/7 Claim Desktop Bot
cd /d "%~dp0"

echo ======================================================================
echo   Return App - 24/7 Marketplace Claim Desktop Bot Service
echo   Continuous Meesho automation; other marketplaces stay assisted/manual.
echo ======================================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Error: Node.js was not found. Please install Node.js from https://nodejs.org.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Node modules not found. Running npm install...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting the Return App claim bot. Sign in inside the window.
echo Closing the window leaves the bot in the system tray.
echo Quit from the tray menu to stop it. This window restarts the app only if it crashes.
echo.

:loop
echo [%date% %time%] Starting the claim bot...
call npm run desktop
if errorlevel 1 (
  echo [%date% %time%] The claim bot stopped unexpectedly. Restarting in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto loop
)
echo [%date% %time%] The claim bot was closed.
exit /b 0
