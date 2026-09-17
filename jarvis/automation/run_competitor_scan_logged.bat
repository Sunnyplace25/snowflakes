@echo off
rem ============================================================
rem run_competitor_scan_logged.bat
rem  競合スキャンをログ付きで実行するラッパー
rem  タスクスケジューラから呼び出される。直接実行も可。
rem ============================================================

set "JARVIS_ROOT=%~dp0.."
set "LOGFILE=%JARVIS_ROOT%\logs\competitor-scan.log"

rem logs ディレクトリがなければ作成
if not exist "%JARVIS_ROOT%\logs" mkdir "%JARVIS_ROOT%\logs"

echo [%DATE% %TIME%] ===== START ===== >> "%LOGFILE%"
node "%JARVIS_ROOT%\tools\run_competitor_scan.mjs" 1 >> "%LOGFILE%" 2>&1
set EXITCODE=%ERRORLEVEL%
echo [%DATE% %TIME%] ===== END (exit=%EXITCODE%) ===== >> "%LOGFILE%"

exit /b %EXITCODE%
