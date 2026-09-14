# dsh-weixin 一次性看门狗（由 Windows 计划任务运行，独立于 dsh 进程树）
#
# 职责：
#   1. 等待微信扫码登录产生的凭据文件出现（最多 30 分钟）
#   2. 出现后重启 dsh web，使 web profile 重新读取 cordis.patch.yml 并挂载微信通道插件
#   3. 用「原进程的精确命令行」重启，避免 PATH / 工作目录差异
#   4. 验证 3080 恢复，并把结果写入状态文件

$ErrorActionPreference = 'Continue'
$root = 'D:\deepwork\手机端\dsh-weixin-channel'
$statusPath = Join-Path $root 'restart-status.json'
$logPath = Join-Path $root 'restart.log'

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logPath -Value $line -Encoding UTF8
}

function Write-Status($obj) {
  $obj | ConvertTo-Json -Depth 4 | Set-Content -Path $statusPath -Encoding UTF8
}

function Test-Web {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3080' -TimeoutSec 5 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

Write-Log '=== watchdog started ==='
Write-Status @{ stage = 'waiting-credentials'; at = (Get-Date).ToString('o') }

$tokenIndex = 'C:\Users\sxylv\.dsh\weixin\accounts.json'
$deadline = (Get-Date).AddMinutes(30)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $tokenIndex) { break }
  Start-Sleep -Seconds 5
}

if (-not (Test-Path $tokenIndex)) {
  Write-Log 'no credentials within 30min; watchdog exits without restart'
  Write-Status @{ stage = 'timeout'; at = (Get-Date).ToString('o') }
  exit 0
}

$accountIds = @(Get-Content $tokenIndex -Raw | ConvertFrom-Json)
Write-Log "credentials detected: $($accountIds -join ',')"
Write-Status @{ stage = 'credentials-found'; at = (Get-Date).ToString('o'); accountIds = $accountIds }

Start-Sleep -Seconds 12   # 等登录进程落盘并退出

$top = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'pnpm' -and $_.CommandLine -match 'dsh' -and $_.CommandLine -match '\bweb\b' } |
  Sort-Object CreationDate |
  Select-Object -First 1

if (-not $top) {
  Write-Log 'dsh web top process not found; abort restart'
  Write-Status @{ stage = 'no-target'; at = (Get-Date).ToString('o') }
  exit 1
}

$exe = $top.ExecutablePath
$cmdline = $top.CommandLine
$wd = 'C:\Users\sxylv\deepseek-harness-v015'
Write-Log "target pid=$($top.ProcessId) exe=$exe"
Write-Log "target cmdline=$cmdline"

& taskkill.exe /PID $top.ProcessId /T /F 2>&1 | ForEach-Object { Write-Log "taskkill: $_" }
Start-Sleep -Seconds 6

$launched = $false
for ($attempt = 1; $attempt -le 2; $attempt++) {
  Write-Log "relaunch attempt $attempt"
  try {
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = $cmdline
      CurrentDirectory = $wd
    }
    Write-Log "wmi create: ReturnValue=$($r.ReturnValue) pid=$($r.ProcessId)"
    if ($r.ReturnValue -eq 0) { $launched = $true }
  } catch {
    Write-Log "wmi create failed: $($_.Exception.Message)"
  }
  if (-not $launched) {
    try {
      Start-Process -FilePath 'pnpm.cmd' -ArgumentList 'dsh', 'web' -WorkingDirectory $wd `
        -RedirectStandardOutput (Join-Path $root 'dsh-web.out.log') `
        -RedirectStandardError (Join-Path $root 'dsh-web.err.log') -WindowStyle Hidden
      $launched = $true
      Write-Log 'fallback Start-Process pnpm.cmd issued'
    } catch {
      Write-Log "fallback relaunch failed: $($_.Exception.Message)"
    }
  }

  $ok = $false
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 3
    if (Test-Web) { $ok = $true; break }
  }
  if ($ok) { break }
  Write-Log "attempt $attempt did not restore port 3080"
}

$mount = 'C:\Users\sxylv\.dsh\weixin\mount-status.json'
Start-Sleep -Seconds 5
Write-Log "web restored=$ok mount-status-exists=$(Test-Path $mount)"
Write-Status @{
  stage       = if ($ok) { 'restarted' } else { 'restart-failed' }
  at          = (Get-Date).ToString('o')
  webRestored = $ok
  launched    = $launched
  mountStatus = if (Test-Path $mount) { (Get-Content $mount -Raw) } else { $null }
}
Write-Log '=== watchdog finished ==='
