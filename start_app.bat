@echo off
title Order System Launcher

echo ========================================================
echo  Order System - Graduation Project
echo ========================================================
echo.

if exist "node_modules" (
    echo [OK] Modules are installed.
) else (
    echo [INFO] First time setup. Installing modules...
    echo        Please wait a moment.
    call npm install
)

echo.
echo [INFO] Starting HTTPS Server...
echo.
echo  ------------------------------------------
echo   Customer App: https://localhost/
echo   Kitchen App:  https://localhost/admin/
echo  ------------------------------------------
echo.
echo  Press [Ctrl] + [C] to stop the server.
echo.

node index.js
pause