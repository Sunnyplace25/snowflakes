# ============================================================
# install_competitor_scan_task.ps1
# Jarvis Mercari Competitor Scan - Task Scheduler Setup
# ============================================================
#
# Usage (no admin required):
#   powershell -ExecutionPolicy Bypass -File ".\jarvis\automation\install_competitor_scan_task.ps1"
#
# Stop (disable without deleting):
#   schtasks /Change /TN "JarvisCompetitorScan" /DISABLE
#
# Resume:
#   schtasks /Change /TN "JarvisCompetitorScan" /ENABLE
#
# Delete completely:
#   schtasks /Delete /TN "JarvisCompetitorScan" /F
#
# Notes:
#   - Only operates on "JarvisCompetitorScan" task
#   - Does not touch any other tasks, dashboard, or manual scans
#   - Safe to re-run (overwrites existing task)
#   - If PC is OFF at 02:00, runs after next login (StartWhenAvailable)
# ============================================================

$TaskName = "JarvisCompetitorScan"

$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$JarvisRoot = Split-Path -Parent $ScriptDir
$BatFile    = Join-Path $ScriptDir "run_competitor_scan_logged.bat"
$LogFile    = Join-Path $JarvisRoot "logs\competitor-scan.log"

if (-not (Test-Path $BatFile)) {
    Write-Error "Not found: $BatFile"
    exit 1
}

Write-Host "============================================================"
Write-Host " Jarvis Competitor Scan - Task Scheduler Setup"
Write-Host "============================================================"
Write-Host " Task     : $TaskName"
Write-Host " Bat file : $BatFile"
Write-Host " Log file : $LogFile"
Write-Host " Time     : 02:00 daily"
Write-Host " Miss     : runs after next login"
Write-Host "============================================================"

# Delete existing task if present
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

# Register task via schtasks.exe
# /IT = only run when user is logged on (required for headless:false browser)
# /F  = force overwrite
# /RL LIMITED = run as normal user (not elevated)
$tr = '"' + $BatFile + '"'
$result = schtasks /Create /TN $TaskName /TR $tr /SC DAILY /ST 02:00 /IT /RL LIMITED /F 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host " [OK] Task registered: $TaskName at 02:00 daily"
    Write-Host ""
    Write-Host " Check:"
    Write-Host "   schtasks /Query /TN JarvisCompetitorScan /FO LIST"
    Write-Host ""
    Write-Host " Test run (manual):"
    Write-Host "   schtasks /Run /TN JarvisCompetitorScan"
    Write-Host "   # Check log:"
    Write-Host "   Get-Content '$LogFile' -Tail 30"
    Write-Host ""
    Write-Host " Pause:"
    Write-Host "   schtasks /Change /TN JarvisCompetitorScan /DISABLE"
    Write-Host " Resume:"
    Write-Host "   schtasks /Change /TN JarvisCompetitorScan /ENABLE"
    Write-Host " Delete:"
    Write-Host "   schtasks /Delete /TN JarvisCompetitorScan /F"
    Write-Host ""
} else {
    Write-Host " Result: $result"
    Write-Error "Task registration failed (exit $LASTEXITCODE)"
    exit 1
}
