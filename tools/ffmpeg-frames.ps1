<#
.SYNOPSIS
  Extract frames from a video with ffmpeg and tile them into one PNG contact sheet.

.DESCRIPTION
  Two modes:
    * -Frames N            : uniform sampling. Frames=1 keeps native resolution (no tile).
    * -Timestamps "a,b,c"  : exact moments (used for scene-aware selection).

  With -SceneExtra K the uniform picks get augmented by the K moments whose scene-change
  score is highest, so detail lands where the picture actually changes instead of being
  spread evenly over the timeline. Uniform picks still guarantee timeline coverage.

  NOTE: ASCII-only on purpose (Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ffmpeg-frames.ps1 `
      -Path D:\a.mp4 -Out D:\a.png -Frames 3 -SceneExtra 3

.EXITCODES
  0 success / 2 ffmpeg produced no output / 3 other failure (message on stderr)
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Frames = 3,
  [double]$Duration = 0,
  [int]$TileWidth = 640,
  [int]$TileHeight = 360,
  [int]$Columns = 0,
  [string]$Ffmpeg = '',
  [string]$Timestamps = '',
  [int]$SceneExtra = 0,
  [double]$SceneMinScore = 0.012
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ffmpeg-common.ps1')

# SceneMinScore 默认 0.012 是实测定的：手持单镜头视频相邻帧差异最大约 0.016、
# 中位 0.0011，硬切换通常 >0.05。阈值太低会把"平移中的普通一帧"当成变化点。

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    [Console]::Error.WriteLine("source not found: $Path")
    exit 3
  }
  if ($Frames -lt 1) { $Frames = 1 }

  $ff = Get-FfmpegPath $Ffmpeg
  if (-not $ff) {
    [Console]::Error.WriteLine('ffmpeg not found')
    exit 3
  }

  # Real duration beats the value the chat protocol reports, which can overrun the stream.
  if ($Duration -le 0) {
    $Duration = Get-VideoDuration (Get-FfprobePath $ff '') $Path
  }

  # ---- choose the moments ----
  $picked = New-Object System.Collections.Generic.List[double]
  if ($Timestamps) {
    foreach ($p in $Timestamps.Split(',')) {
      $v = 0.0
      if ([double]::TryParse($p.Trim(), [ref]$v) -and $v -ge 0) { $picked.Add($v) }
    }
  } else {
    $d = if ($Duration -gt 0) { $Duration } else { 30.0 }
    for ($i = 0; $i -lt $Frames; $i++) {
      $frac = if ($Frames -eq 1) { 0.5 } else { 0.15 + (0.7 * $i / ($Frames - 1)) }
      $picked.Add([Math]::Round($d * $frac, 3))
    }
  }
  if ($picked.Count -eq 0) {
    [Console]::Error.WriteLine('no timestamps selected')
    exit 3
  }

  # ---- optional scene-aware augmentation ----
  $sceneUsed = 0
  if ($SceneExtra -gt 0) {
    $sceneScript = Join-Path $PSScriptRoot 'ffmpeg-scene.ps1'
    if (Test-Path -LiteralPath $sceneScript) {
      $csv = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $sceneScript `
        -Path $Path -Ffmpeg $ff 2>$null
      $picks = New-Object System.Collections.Generic.List[object]
      foreach ($row in $csv) {
        $parts = ([string]$row) -split ','
        if ($parts.Count -lt 2) { continue }
        $t = 0.0; $s = 0.0
        if (-not [double]::TryParse($parts[0], [ref]$t)) { continue }
        if (-not [double]::TryParse($parts[1], [ref]$s)) { continue }
        if ($s -lt $SceneMinScore) { continue }
        $picks.Add([pscustomobject]@{ t = $t; s = $s })
      }
      # Highest score first, then keep only picks that stay clear of EVERY already-chosen
      # moment (uniform picks AND earlier scene picks). Without the second part, two scene
      # picks could land in the same instant and two tiles came out near-identical.
      foreach ($c in ($picks | Sort-Object s -Descending)) {
        if ($sceneUsed -ge $SceneExtra) { break }
        $far = $true
        foreach ($p in $picked) {
          if ([Math]::Abs($p - $c.t) -lt 0.35) { $far = $false; break }
        }
        if (-not $far) { continue }
        $picked.Add([Math]::Round($c.t, 3))
        $sceneUsed++
      }
    }
  }
  $picked = @($picked | Sort-Object -Unique)
  $frameCount = $picked.Count

  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

  # ---- build ----
  if ($frameCount -eq 1) {
    # Single frame: no tiling, keep native resolution.
    $ss = '{0:0.###}' -f $picked[0]
    $ffArgs = @('-hide_banner', '-loglevel', 'error', '-y', '-ss', $ss, '-i', $Path,
      '-frames:v', '1', $Out)
  } elseif ($frameCount -le 6) {
    if ($Columns -lt 1) { $Columns = [int][Math]::Ceiling([Math]::Sqrt($frameCount)) }
    $rows = [int][Math]::Ceiling($frameCount / [double]$Columns)
    $cells = $Columns * $rows
    # One pass: fps on a real time base, then tile. Pad short sheets by cloning a frame.
    $rate = $frameCount / [Math]::Max(0.5, $Duration)
    $filters = "fps=$('{0:0.######}' -f $rate),scale=$($TileWidth):$($TileHeight)"
    if ($cells -gt $frameCount) {
      $filters += ",tpad=stop_mode=clone:stop_duration=3600"
    }
    $filters += ",tile=${Columns}x${rows}"
    $ffArgs = @('-hide_banner', '-loglevel', 'error', '-y', '-i', $Path,
      '-vf', $filters, '-frames:v', '1', $Out)
  } else {
    # Exact moments: select each timestamp. ffmpeg cannot tile an arbitrary selection, so
    # the frames go to a temp dir and get composited by the .NET caller below.
    if ($Columns -lt 1) { $Columns = [int][Math]::Ceiling([Math]::Sqrt($frameCount)) }
    $rows = [int][Math]::Ceiling($frameCount / [double]$Columns)
    $tmpDir = Join-Path $env:TEMP ("dshframes-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    try {
      $i = 0
      $each = @()
      foreach ($t in $picked) {
        $file = Join-Path $tmpDir ("f{0:00}.png" -f $i)
        $code = Invoke-FfmpegLine $ff @(
          '-hide_banner', '-loglevel', 'error', '-y', '-ss', ('{0:0.###}' -f $t), '-i', $Path,
          '-frames:v', '1', '-vf', "scale=$($TileWidth):$($TileHeight)", $file) $null
        if ($code -ne 0 -or -not (Test-Path -LiteralPath $file)) {
          [Console]::Error.WriteLine("frame at $t s failed (exit $code)")
          exit 3
        }
        $each += $file
        $i++
      }
      # composite
      Add-Type -AssemblyName System.Drawing
      $sheet = New-Object System.Drawing.Bitmap(($Columns * $TileWidth), ($rows * $TileHeight))
      $g = [System.Drawing.Graphics]::FromImage($sheet)
      $g.Clear([System.Drawing.Color]::Black)
      $g.Dispose()
      for ($k = 0; $k -lt $each.Count; $k++) {
        $img = [System.Drawing.Image]::FromFile($each[$k])
        $col = $k % $Columns
        $row = [int][Math]::Floor($k / $Columns)
        $g2 = [System.Drawing.Graphics]::FromImage($sheet)
        $g2.DrawImage($img, ($col * $TileWidth), ($row * $TileHeight), $TileWidth, $TileHeight)
        $g2.Dispose()
        $img.Dispose()
      }
      $sheet.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $sheet.Dispose()
      Write-Output ("ok {0} {1} frames={2} duration={3:0.###} columns={4} scene={5} mode=select" -f `
          $Out, (Get-Item -LiteralPath $Out).Length, $frameCount, $Duration, $Columns, $sceneUsed)
      exit 0
    } finally {
      Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  # ffmpeg writes $Out itself -- never ALSO redirect stdout to $Out, or cmd holds the file
  # open first and ffmpeg then fails with "Permission denied" from the image2 muxer.
  $errFile = Join-Path $env:TEMP ("dshfrm-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + ".err")
  try {
    $code = Invoke-FfmpegLine $ff $ffArgs $errFile
    if ($code -ne 0) {
      $tail = if (Test-Path -LiteralPath $errFile) { (Get-Content -LiteralPath $errFile | Select-Object -Last 4) -join ' | ' } else { '' }
      [Console]::Error.WriteLine("ffmpeg failed ($code): $tail")
      exit 3
    }
  } finally {
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
  }
  if (-not (Test-Path -LiteralPath $Out)) {
    [Console]::Error.WriteLine('ffmpeg produced no output file')
    exit 2
  }

  $len = (Get-Item -LiteralPath $Out).Length
  Write-Output ("ok {0} {1} frames={2} duration={3:0.###} columns={4} scene={5} mode=tile" -f `
      $Out, $len, $frameCount, $Duration, $Columns, $sceneUsed)
  exit 0
}
catch {
  [Console]::Error.WriteLine("ffmpeg frames failed: $($_.Exception.Message)")
  exit 3
}

