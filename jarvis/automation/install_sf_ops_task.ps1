# ============================================================
# install_sf_ops_task.ps1
# Snow flakes Ops Runner — Windows Task Scheduler セットアップ
# ============================================================
#
# 目的:
#   jarvis/automation/sf_ops_runner.js を Windows Task Scheduler で
#   毎朝 6:00 に実行するタスクを登録する。
#
# 使用方法（管理者権限は不要）:
#   powershell -ExecutionPolicy Bypass -File ".\jarvis\automation\install_sf_ops_task.ps1"
#
# 削除方法:
#   Unregister-ScheduledTask -TaskName "SnowflakesOpsRunner" -Confirm:$false
#
# 注意:
#   - Snow flakes/JARVIS 専用のタスク名 "SnowflakesOpsRunner" のみ操作する
#   - 既存の他のタスクには一切触れない
#   - 安全に再実行可能（既存タスクは上書き登録）
#   - PCが6:00にOFFだった場合: 次回起動後に実行（StartWhenAvailable）
#
# ============================================================

$TaskName   = "SnowflakesOpsRunner"
$TaskDescr  = "Snow flakes JARVIS - Daily Data Sync at 06:00"

# jarvis ルートを解決
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$JarvisRoot = Split-Path -Parent $ScriptDir

# Node.js の場所を検索
$NodePath = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $NodePath) {
    Write-Error "node が見つかりません。Node.js をインストールしてから再実行してください。"
    exit 1
}

$RunnerPath = Join-Path $JarvisRoot "automation\sf_ops_runner.js"
if (-not (Test-Path $RunnerPath)) {
    Write-Error "sf_ops_runner.js が見つかりません: $RunnerPath"
    exit 1
}

$EnvFilePath = Join-Path $JarvisRoot ".env"

Write-Host "============================================================"
Write-Host " Snow flakes Ops Runner — Task Scheduler セットアップ"
Write-Host "============================================================"
Write-Host " タスク名 : $TaskName"
Write-Host " Node     : $NodePath"
Write-Host " Runner   : $RunnerPath"
Write-Host " .env     : $EnvFilePath (存在する場合のみ読み込み)"
Write-Host " 実行時刻 : 毎朝 06:00"
Write-Host " 逃した場合: 次回起動後に実行"
Write-Host "============================================================"

# ─── Action ─────────────────────────────────────────────────
$Action = New-ScheduledTaskAction `
    -Execute    $NodePath `
    -Argument   "--env-file-if-exists=`"$EnvFilePath`" `"$RunnerPath`"" `
    -WorkingDirectory $JarvisRoot

# ─── Trigger: 毎朝 06:00 ────────────────────────────────────
$TriggerDaily = New-ScheduledTaskTrigger -Daily -At "06:00"

# ─── Settings ───────────────────────────────────────────────
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable:$false `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -MultipleInstances IgnoreNew

# ─── Principal（現在のユーザーで実行）───────────────────────
$Principal = New-ScheduledTaskPrincipal `
    -UserId    ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel   Highest

# ─── 既存タスクの確認 ────────────────────────────────────────
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
    Write-Host " [OK] タスク '$TaskName' を毎朝 06:00 で登録しました。"
    Write-Host ""
    Write-Host " 確認方法:"
    Write-Host "   Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
    Write-Host ""
    Write-Host " 削除方法:"
    Write-Host "   Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
    Write-Host ""
} catch {
    Write-Error "タスク登録に失敗しました: $_"
    exit 1
}
