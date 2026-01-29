@echo off
title 注文システム起動ツール

if exist "node_modules" (
    echo 起動準備完了。システムを起動します...
) else (
    echo 初回セットアップを実行します（npm install）...
    echo ※数分かかる場合があります。お待ちください。
    call npm install
)

echo.
echo ==========================================
echo  HTTPS Server running...
echo  客席側: https://localhost/
echo  厨房側: https://localhost/admin/
echo ==========================================
echo.

node index.js
pause