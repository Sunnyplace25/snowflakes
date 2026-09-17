@echo off
set "NODE=C:\Program Files\nodejs\node.exe"
set "JARVIS=C:\Users\Sunny\snowflakes\jarvis"
set "SCRIPT=%JARVIS%\tools\run_competitor_scan.mjs"
set "LOGDIR=%JARVIS%\logs"
set "LOGFILE=%LOGDIR%\competitor-scan.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d "%JARVIS%"
echo [%DATE% %TIME%] ===== START ===== >> "%LOGFILE%"
"%NODE%" "%SCRIPT%" 1 >> "%LOGFILE%" 2>&1
echo [%DATE% %TIME%] ===== END (exit=%ERRORLEVEL%) ===== >> "%LOGFILE%"
