<#
.SYNOPSIS
  Report scene-change scores for a video as CSV: "seconds,score" per line.

.DESCRIPTION
  Uses ffmpeg's own scene detector (select + metadata=print) so no managed decoding is
  involved. Score 0 = identical to the previous frame, 1 = completely different.

  Hard-won detail: metadata=print:file=<path> cannot take a Windows path -- the filter
  parser strips backslashes and treats the drive colon as an option separator, so every
  "file=C:\..." variant failed. Writing to stdout (file=-) under -loglevel quiet works,
  and the metadata stream then interleaves pts_time / scene_score tokens that we pair in
  order (line structure is not reliable).

  NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ffmpeg-scene.ps1 -Path D:\a.mp4

.EXITCODES
  0 success / 3 failure (message on stderr)
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$MinScore = 0,
  [int]$Limit = 4000,
  [string]$Ffmpeg = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ffmpeg-common.ps1')

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    [Console]::Error.WriteLine("source not found: $Path")
    exit 3
  }
  $ff = Get-FfmpegPath $Ffmpeg
  if (-not $ff) {
    [Console]::Error.WriteLine('ffmpeg not found')
    exit 3
  }

  $stamp = [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $raw = Join-Path $env:TEMP "dshscene-$stamp.txt"
  try {
    # Inline cmd with its own redirection: metadata goes to stdout under -loglevel quiet,
    # and stderr is discarded. Passing the path as a filter argument (metadata=print:file=)
    # does not work for Windows paths at all.
    $filter = "select='gte(scene,$MinScore)',metadata=print:file=-"
    $inner = '"' + $ff + '" -hide_banner -loglevel quiet -i "' + $Path +
    '" -vf "' + $filter + '" -an -f null - > "' + $raw + '" 2>nul'
    $null = & $env:ComSpec /c ('cmd /c "' + $inner + '"') 2>&1

    if (-not (Test-Path -LiteralPath $raw) -or (Get-Item -LiteralPath $raw).Length -eq 0) {
      [Console]::Error.WriteLine('ffmpeg produced no metadata output')
      exit 3
    }

    $times = New-Object System.Collections.Generic.List[double]
    $scores = New-Object System.Collections.Generic.List[double]
    foreach ($lineText in (Get-Content -LiteralPath $raw)) {
      foreach ($m in [regex]::Matches($lineText, 'pts_time:([0-9.eE+\-]+)')) {
        $v = 0.0
        if ([double]::TryParse($m.Groups[1].Value, [ref]$v)) { $times.Add($v) }
      }
      foreach ($m in [regex]::Matches($lineText, 'scene_score=([0-9.eE+\-]+)')) {
        $v = 0.0
        if ([double]::TryParse($m.Groups[1].Value, [ref]$v)) { $scores.Add($v) }
      }
    }

    $n = [Math]::Min($times.Count, $scores.Count)
    if ($n -eq 0) {
      [Console]::Error.WriteLine('no scene metadata produced')
      exit 3
    }
    if ($Limit -gt 0 -and $n -gt $Limit) { $n = $Limit }

    $sb = New-Object System.Text.StringBuilder
    for ($i = 0; $i -lt $n; $i++) {
      [void]$sb.AppendLine(('{0:0.###},{1:0.######}' -f $times[$i], $scores[$i]))
    }
    Write-Output $sb.ToString().TrimEnd()
    exit 0
  } finally {
    Remove-Item -LiteralPath $raw -Force -ErrorAction SilentlyContinue
  }
}
catch {
  [Console]::Error.WriteLine("scene probe failed: $($_.Exception.Message)")
  exit 3
}
