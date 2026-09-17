# ============================================================
# install_competitor_scan_task.ps1
# Jarvis — メルカリ競合スキャン 1日1回自動実行タスク
# ============================================================
#
# 目的:
#   node tools/run_competitor_scan.mjs 1 を Windows Task Scheduler で
#   毎朝 02:00 に実行する。
#   headless:false のブラウザを使うため Interactive ログオン必須。
#   ログは logs/competitor-scan.log へ追記。
#
# 使用方法（管理者権限不要）:
#   powershell -ExecutionPolicy Bypass -File ".\jarvis\automation\install_competitor_scan_task.ps1"
#
# 停止・削除方法:
#   Unregister-ScheduledTask -TaskName "JarvisCompetitorScan" -Confirm:$false
#
# 一時的に無効化（削除せず止める）:
#   Disable-ScheduledTask -TaskName "JarvisCompetitorScan"
#   # 再開
#   Enable-ScheduledTask  -TaskName "JarvisCompetitorScan"
#
# 注意:
#   - このスクリプトが操作するのは "JarvisCompetitorScan" タスクのみ
#   - 既存の他タスク・ダッシュボード・手動スキャンには一切触れない
#   - 安全に再実行可能（既存タスクは上書き）
#   - PC が 02:00 に OFF だった場合: 次回ログイン後に自動実行
#
# ============================================================

$TaskName  = "JarvisCompetitorScan"
$TaskDescr = "Jarvis - Daily Mercari Competitor Scan at 02:00"
$RunHour   = 2   # 実行時刻（24h）

# ─── パス解決 ────────────────────────────────────────────────
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$JarvisRoot = Split-Path -Parent $ScriptDir

$NodeCmd  = Get-Command node -ErrorAction SilentlyContinue
$NodePath = if ($NodeCmd) { $NodeCmd.Source } else { $null }
if (-not $NodePath) {
    Write-Error "node が見つかりません。Node.js をインストールしてから再実行してください。"
    exit 1
}

$ScanScript = Join-Path $JarvisRoot "tools\run_competitor_scan.mjs"
if (-not (Test-Path $ScanScript)) {
    Write-Error "run_competitor_scan.mjs が見つかりません: $ScanScript"
    exit 1
}

$LogDir = Join-Path $JarvisRoot "logs"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
$LogFile = Join-Path $LogDir "competitor-scan.log"

# ─── cmd ラッパーでログ出力 ──────────────────────────────────
# タイムスタンプをログ先頭に付けて追記する
$CmdArg = "/c echo [%DATE% %TIME%] START >> `"$LogFile`" 2>&1 & `"$NodePath`" `"$ScanScript`" 1 >> `"$LogFile`" 2>&1 & echo [%DATE% %TIME%] END >> `"$LogFile`" 2>&1"

Write-Host "============================================================"
Write-Host " Jarvis Competitor Scan — Task Scheduler セットアップ"
Write-Host "============================================================"
Write-Host " タスク名   : $TaskName"
Write-Host " Node       : $NodePath"
Write-Host " スクリプト : $ScanScript"
Write-Host " ログ       : $LogFile"
Write-Host " 実行時刻   : 毎朝 0$RunHour`:00"
Write-Host " 逃した場合 : 次回ログイン後に実行"
Write-Host "============================================================"

# ─── Action ─────────────────────────────────────────────────
$Action = New-ScheduledTaskAction `
    -Execute          "cmd.exe" `
    -Argument         $CmdArg `
    -WorkingDirectory $JarvisRoot

# ─── Trigger: 毎朝 02:00 ────────────────────────────────────
$TriggerDaily = New-ScheduledTaskTrigger -Daily -At "$RunHour`:00"

# ─── Settings ───────────────────────────────────────────────
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -MultipleInstances IgnoreNew

# ─── Principal（現在のユーザー・ログオン時のみ実行）─────────
# LogonType Interactive = ユーザーがログオンしている場合のみ実行
# → headless:false のブラウザが動く条件を満たす
$Principal = New-ScheduledTaskPrincipal `
    -UserId    ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel  Normal

# ─── 既存タスクの確認・上書き ────────────────────────────────
$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Write-Host " 既存タスク '$TaskName' を上書き登録します..."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# ─── タスク登録 ──────────────────────────────────────────────
try {
    Register-ScheduledTask `
        -TaskName    $TaskName `
        -Description $TaskDescr `
        -Action      $Action `
        -Trigger     $TriggerDaily `
        -Settings    $Settings `
        -Principal   $Principal `
        -Force | Out-Null

    Write-Host ""
    Write-Host " [OK] タスク '$TaskName' を毎朝 02:00 で登録しました。"
    Write-Host ""
    Write-Host " 確認:"
    Write-Host "   Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
    Write-Host ""
    Write-Host " 手動テスト実行:"
    Write-Host "   Start-ScheduledTask -TaskName '$TaskName'"
    Write-Host "   # ログ確認"
    Write-Host "   Get-Content `"$LogFile`" -Tail 30"
    Write-Host ""
    Write-Host " 一時停止:"
    Write-Host "   Disable-ScheduledTask -TaskName '$TaskName'"
    Write-Host " 再開:"
    Write-Host "   Enable-ScheduledTask  -TaskName '$TaskName'"
    Write-Host " 完全削除:"
    Write-Host "   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
    Write-Host ""
} catch {
    Write-Error "タスク登録に失敗しました: $_"
    exit 1
}
