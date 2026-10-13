@echo off
setlocal
title Return App
cd /d "%~dp0"

echo ========================================
echo  Return App - starting up
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org, then run RUN.bat again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing packages. This can take a few minutes.
  call npm install
  if errorlevel 1 (
    echo npm install failed. Read the messages above, then run RUN.bat again.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo WARNING: no .env file was found in this folder.
  echo Create .env with a DATABASE_URL line. Until then the app opens but cannot reach the database.
  echo.
)

echo Starting the app. Keep this window open while you work.
echo   Web app:    http://localhost:5173
echo   API health: http://localhost:3001/api/health
echo   To stop the app, press Ctrl+C in this window.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 6; Start-Process 'http://localhost:5173'"

call npm run dev

echo.
echo The app has stopped.
pause
