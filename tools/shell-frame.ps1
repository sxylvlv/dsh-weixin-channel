<#
.SYNOPSIS
  Grab one frame from a video (or any file the Windows shell can thumbnail) and save it as PNG.

.DESCRIPTION
  The DSH process runs on Windows and has no ffmpeg. The shell's IShellItemImageFactory
  can call the system decoders (including HEVC extensions) to produce a video's first
  frame, which is far cheaper than installing a transcoder.

  NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
  unless a UTF-8 BOM is present, so non-ASCII literals here would come out as mojibake.
  Chinese wording lives on the Node side (lib/video-frame.mjs).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File shell-frame.ps1 -Path D:\a.mp4 -Out D:\a.png

.EXITCODES
  0 success / 2 shell has no thumbnail for this file / 3 other failure (message on stderr)
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1920,
  [int]$Height = 1080
)

$ErrorActionPreference = 'Stop'

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    [Console]::Error.WriteLine("source not found: $Path")
    exit 3
  }

  Add-Type -AssemblyName System.Drawing

  Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItemImageFactory {
  void GetImage(SIZE size, int flags, out IntPtr phbm);
}

[StructLayout(LayoutKind.Sequential)]
public struct SIZE { public int cx; public int cy; public SIZE(int w, int h) { cx = w; cy = h; } }

public static class ShellFrame {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid,
      [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory factory);

  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);

  const int SIIGBF_RESIZETOFIT   = 0x0;
  const int SIIGBF_BIGGERSIZEOK  = 0x1;
  const int SIIGBF_THUMBNAILONLY = 0x8;

  // Returns true when an image was produced and written; false when the shell has none.
  public static bool Save(string path, int w, int h, string outPath) {
    var iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    IShellItemImageFactory factory;
    SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out factory);
    IntPtr hbm;
    factory.GetImage(new SIZE(w, h), SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK | SIIGBF_RESIZETOFIT, out hbm);
    if (hbm == IntPtr.Zero) { return false; }
    try {
      using (var bmp = Image.FromHbitmap(hbm)) { bmp.Save(outPath, ImageFormat.Png); }
      return true;
    } finally {
      DeleteObject(hbm);
    }
  }
}
'@ -ReferencedAssemblies System.Drawing

  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }

  $ok = [ShellFrame]::Save($Path, $Width, $Height, $Out)
  if (-not $ok) {
    [Console]::Error.WriteLine('shell returned an empty thumbnail handle')
    exit 2
  }
  if (-not (Test-Path -LiteralPath $Out)) {
    [Console]::Error.WriteLine('no output file produced')
    exit 3
  }
  $len = (Get-Item -LiteralPath $Out).Length
  Write-Output "ok $Out $len"
  exit 0
}
catch {
  [Console]::Error.WriteLine("frame extraction failed: $($_.Exception.Message)")
  exit 3
}
