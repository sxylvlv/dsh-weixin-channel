<#
.SYNOPSIS
  Shared helpers for the ffmpeg-based video tools (dot-source this file).

.DESCRIPTION
  Finds ffmpeg/ffprobe when they are not on PATH. This machine had a half-installed winget
  FFmpeg (its package bin/ directory was empty) and a stale PATH entry pointing at it, so
  PATH alone is not trustworthy.

  NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).
#>

function Get-FfmpegPath([string]$explicit) {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($explicit) { $candidates.Add($explicit) }
  if ($env:DSH_WEIXIN_FFMPEG) { $candidates.Add($env:DSH_WEIXIN_FFMPEG) }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($root in @(
      'D:\deepwork\手机端\bin',
      'D:\deepwork\bin',
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'),
      'C:\ffmpeg\bin',
      'C:\Program Files\ffmpeg\bin')) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    if ((Get-Item -LiteralPath $root).PSIsContainer) {
      $hit = Get-ChildItem -LiteralPath $root -Recurse -Filter 'ffmpeg.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($hit) { return $hit.FullName }
    }
  }
  return $null
}

function Get-FfprobePath([string]$ffmpegPath, [string]$explicit) {
  if ($explicit -and (Test-Path -LiteralPath $explicit)) { return $explicit }
  if ($ffmpegPath) {
    $sibling = Join-Path (Split-Path -Parent $ffmpegPath) 'ffprobe.exe'
    if (Test-Path -LiteralPath $sibling) { return $sibling }
  }
  $cmd = Get-Command ffprobe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-VideoDuration([string]$ffprobePath, [string]$path) {
  if (-not $ffprobePath) { return 0.0 }
  try {
    $text = & $ffprobePath -v error -show_entries format=duration `
      -of default=noprint_wrappers=1:nokey=1 -- $path 2>$null
    $parsed = 0.0
    if ([double]::TryParse(($text | Select-Object -First 1), [ref]$parsed) -and $parsed -gt 0) {
      return $parsed
    }
  } catch {
    # caller falls back to the duration reported by the chat protocol
  }
  return 0.0
}

<#
  Run one ffmpeg command line and return its exit code.

  The command is handed to cmd /c inline so that PowerShell does the Unicode handling:
  write the same line to a .bat with Set-Content -Encoding ASCII and a Chinese directory
  name such as D:\deepwork\手机端 becomes "???" and cmd cannot find ffmpeg.
#>
function Invoke-FfmpegLine([string]$ffmpegPath, [string[]]$ffArgs, [string]$stderrFile, [string]$stdoutFile) {
  $quoted = $ffArgs | ForEach-Object {
    if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
  }
  $line = '"' + $ffmpegPath + '" ' + ($quoted -join ' ')
  if ($stdoutFile) { $line += ' > "' + $stdoutFile + '"' }
  if ($stderrFile) { $line += ' 2> "' + $stderrFile + '"' }
  $cmdLine = 'cmd /c "' + $line + '"'
  $null = & $env:ComSpec /c $cmdLine 2>&1
  return $LASTEXITCODE
}
