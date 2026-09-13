@echo off
rem Double-click to start Playlist Bracket and open it in your browser.
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"
start "" cmd /c "timeout /t 1 >nul & start http://localhost:3100"
node server.js
