@echo off
setlocal
title Return App 24/7 Claim Desktop Bot
cd /d "%~dp0"

echo ======================================================================
echo   Return App - 24/7 Marketplace Claim Desktop Bot Service
echo   Continuous background automation for Meesho, Flipkart, Amazon, etc.
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

echo Starting always-on desktop claim bot loop. Keep this window running 24/7.
echo To stop the bot, press Ctrl+C in this window.
echo.

:loop
echo [%date% %time%] Starting 24/7 claim desktop bot...
call npm run bot
echo [%date% %time%] Desktop bot stopped or connection dropped. Reconnecting in 10 seconds...
timeout /t 10 /nobreak >nul
goto loop
