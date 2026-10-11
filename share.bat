@echo off
rem Starts the checker and opens a public link to it. Keep this window open while others use the link.
cd /d "%~dp0"
start "Brand Name Check" /min node server.js
echo.
echo Look for the line with https://....trycloudflare.com below. That is the link to share.
echo Close this window to stop sharing.
echo.
cloudflared.exe tunnel --url http://localhost:4173 --no-autoupdate
