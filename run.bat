@echo off
title WhatsApp Automation Bot
echo ===================================================
echo   Starting WhatsApp Automation Control Panel...
echo ===================================================

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed!
    echo Please download and install Node.js v18 or higher from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Check if node_modules exists, install dependencies if missing
if not exist node_modules (
    echo [INFO] node_modules not found. Installing dependencies...
    call npm install
)

:: Check if .env exists, create a default template if missing
if not exist .env (
    echo [INFO] .env file not found. Creating default configuration...
    (
        echo PORT=3005
        echo # DATABASE_URL is optional locally. If empty, local files inside auth_info folder are used.
        echo DATABASE_URL=
    ) > .env
)

:: Start the application
echo [INFO] Starting bot server...
echo.
echo ===================================================
echo   OPEN IN YOUR BROWSER: http://localhost:3005
echo ===================================================
echo.
node index.js
pause
