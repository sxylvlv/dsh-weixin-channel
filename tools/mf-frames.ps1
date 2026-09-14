<#
.SYNOPSIS
  Extract frames from a video at given timestamps via Windows Media Foundation, tile them into one PNG.

.DESCRIPTION
  Why MF: the shell thumbnail factory only ever returns the first frame, and the Windows
  Media Player COM control cannot render without an interactive host. IMFSourceReader
  seeks precisely and decodes in-process, so no ffmpeg and no Office are needed.

  Media Foundation lives in an MTA apartment, and PowerShell 5.1 runs STA, so the whole
  MF session is done on a dedicated MTA background thread inside the C# helper.

  Output is one contact sheet: each frame is captured at CaptureWidth x CaptureHeight,
  scaled into a TileWidth x TileHeight tile, laid out in a Columns-wide grid.

  Note: if the machine lacks a decoder for the codec (e.g. HEVC without the extension),
  extraction fails and exits 2 -- the caller should then fall back to a first-frame grab.

  NOTE: ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 as ANSI unless a UTF-8
  BOM is present, so non-ASCII literals would be mojibake (and can break parsing).
  Chinese wording lives on the Node side (lib/video-frame.mjs).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File mf-frames.ps1 `
      -Path D:\a.mp4 -Out D:\a.png -Seconds "0.5,1.5,2.5" -Columns 3

.EXITCODES
  0 success / 2 MF could not decode (missing codec or unusable stream) / 3 other failure
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Seconds = '0.5,1.5,2.5',
  [int]$Columns = 3,
  [int]$CaptureWidth = 1280,
  [int]$CaptureHeight = 720,
  [int]$TileWidth = 640,
  [int]$TileHeight = 360
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
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public static class MfFrames {  // ---- Media Foundation interop (minimal surface) ----
  [ComImport, Guid("2CD2D921-C447-44A7-A13C-4ADABFC247E3"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IMFAttributes {
    int GetItem(ref Guid guidKey, IntPtr pValue);
    int GetItemType(ref Guid guidKey, out int pType);
    int CompareItem(ref Guid guidKey, IntPtr value, out bool pbResult);
    int Compare(IMFAttributes pTheirs, int matchType, out bool pbResult);
    int GetUINT32(ref Guid guidKey, out uint pnValue);
    int GetUINT64(ref Guid guidKey, out ulong pnValue);
    int GetDouble(ref Guid guidKey, out double pfValue);
    int GetGUID(ref Guid guidKey, out Guid pguidValue);
    int GetStringLength(ref Guid guidKey, out uint pcchLength);
    int GetString(ref Guid guidKey, IntPtr pwszValue, uint cchBufSize, IntPtr pcchLength);
    int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out uint pcchLength);
    int GetBlobSize(ref Guid guidKey, out uint pcbBlobSize);
    int GetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize, IntPtr pcbBlobSize);
    int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out uint pcbSize);
    int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
    int SetItem(ref Guid guidKey, IntPtr Value);
    int DeleteItem(ref Guid guidKey);
    int DeleteAllItems();
    int SetUINT32(ref Guid guidKey, uint unValue);
    int SetUINT64(ref Guid guidKey, ulong unValue);
    int SetDouble(ref Guid guidKey, double fValue);
    int SetGUID(ref Guid guidKey, ref Guid guidValue);
    int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
    int SetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize);
    int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
    int LockStore();
    int UnlockStore();
    int GetCount(out uint pcItems);
    int GetItemByIndex(uint unIndex, out Guid pguidKey, IntPtr pValue);
    int CopyAllItems(IMFAttributes pDest);
  }

  [ComImport, Guid("70AE66F2-C809-4E4F-8915-BDCB406B7993"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFSourceReader {
    int GetStreamSelection(uint dwStreamIndex, out bool pfSelected);
    int SetStreamSelection(uint dwStreamIndex, bool fSelected);
    int GetNativeMediaType(uint dwStreamIndex, uint dwMediaTypeIndex, out IMFMediaType ppMediaType);
    int GetCurrentMediaType(uint dwStreamIndex, out IMFMediaType ppMediaType);
    int SetCurrentMediaType(uint dwStreamIndex, IntPtr pdwReserved, IMFMediaType pMediaType);
    int SetCurrentPosition(ref Guid guidTimeFormat, IntPtr varPosition);
    int ReadSample(uint dwStreamIndex, uint dwControlFlags, out uint pdwActualStreamIndex,
                   out uint pdwStreamFlags, out long pllTimestamp, out IMFSample ppSample);
    int Flush(uint dwStreamIndex);
    int GetServiceForStream(uint dwStreamIndex, ref Guid guidService, ref Guid riid, out IntPtr ppvObject);
    int GetPresentationAttribute(uint dwStreamIndex, ref Guid guidAttribute, IntPtr pvarAttribute);
  }

  [ComImport, Guid("44AE0FA8-EA31-4109-8D2E-4CAE4997C555"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFMediaType : IMFAttributes { }

  [ComImport, Guid("C40A00F2-B93A-4D80-AE8C-5A1C634F58E4"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFSample {
    int GetItem(ref Guid guidKey, IntPtr pValue);
    int GetItemType(ref Guid guidKey, out int pType);
    int CompareItem(ref Guid guidKey, IntPtr value, out bool pbResult);
    int Compare(IMFAttributes pTheirs, int matchType, out bool pbResult);
    int GetUINT32(ref Guid guidKey, out uint pnValue);
    int GetUINT64(ref Guid guidKey, out ulong pnValue);
    int GetDouble(ref Guid guidKey, out double pfValue);
    int GetGUID(ref Guid guidKey, out Guid pguidValue);
    int GetStringLength(ref Guid guidKey, out uint pcchLength);
    int GetString(ref Guid guidKey, IntPtr pwszValue, uint cchBufSize, IntPtr pcchLength);
    int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out uint pcchLength);
    int GetBlobSize(ref Guid guidKey, out uint pcbBlobSize);
    int GetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize, IntPtr pcbBlobSize);
    int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out uint pcbSize);
    int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv);
    int SetItem(ref Guid guidKey, IntPtr Value);
    int DeleteItem(ref Guid guidKey);
    int DeleteAllItems();
    int SetUINT32(ref Guid guidKey, uint unValue);
    int SetUINT64(ref Guid guidKey, ulong unValue);
    int SetDouble(ref Guid guidKey, double fValue);
    int SetGUID(ref Guid guidKey, ref Guid guidValue);
    int SetString(ref Guid guidKey, [MarshalAs(UnmanagedType.LPWStr)] string wszValue);
    int SetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize);
    int SetUnknown(ref Guid guidKey, [MarshalAs(UnmanagedType.IUnknown)] object pUnknown);
    int LockStore();
    int UnlockStore();
    int GetCount(out uint pcItems);
    int GetItemByIndex(uint unIndex, out Guid pguidKey, IntPtr pValue);
    int CopyAllItems(IMFAttributes pDest);
    int GetSampleFlags(out uint pdwSampleFlags);
    int SetSampleFlags(uint dwSampleFlags);
    int GetSampleTime(out long phnsSampleTime);
    int SetSampleTime(long hnsSampleTime);
    int GetSampleDuration(out long phnsSampleDuration);
    int SetSampleDuration(long hnsSampleDuration);
    int GetBufferCount(out uint pdwBufferCount);
    int GetBufferByIndex(uint dwIndex, out IMFMediaBuffer ppBuffer);
    int ConvertToContiguousBuffer(out IMFMediaBuffer ppBuffer);
    int AddBuffer(IMFMediaBuffer pBuffer);
    int RemoveBufferByIndex(uint dwIndex);
    int RemoveAllBuffers();
    int GetTotalLength(out uint pcbTotalLength);
    int CopyToBuffer(IMFMediaBuffer pBuffer);
  }

  [ComImport, Guid("045FA593-8799-42B8-BC8D-8968C6453507"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMFMediaBuffer {
    int Lock(out IntPtr ppbBuffer, out uint pcbMaxLength, out uint pcbCurrentLength);
    int Unlock();
    int GetCurrentLength(out uint pcbCurrentLength);
    int SetCurrentLength(uint cbCurrentLength);
    int GetMaxLength(out uint pcbMaxLength);
  }

  [DllImport("mfplat.dll", ExactSpelling = true)] static extern int MFStartup(int Version, int dwFlags);
  [DllImport("mfplat.dll", ExactSpelling = true)] static extern int MFShutdown();
  // Attributes are passed as a raw interface pointer. We never hand MF a managed object:
  // MFCreateAttributes builds a real native store (a managed RCW caused an AV inside
  // MFCreateSourceReaderFromURL even with MarshalAs(Interface)).
  [DllImport("mfreadwrite.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern int MFCreateSourceReaderFromURL(string pwszURL,
      [MarshalAs(UnmanagedType.Interface)] IMFAttributes pAttributes,
      out IMFSourceReader ppSourceReader);

  [DllImport("mfplat.dll", ExactSpelling = true)]
  static extern int MFCreateAttributes([MarshalAs(UnmanagedType.Interface)] out IMFAttributes ppMFAttributes,
      uint cInitialSize);
  [DllImport("mfplat.dll", ExactSpelling = true)]
  static extern int MFCreateMediaType(out IMFMediaType ppMFType);

  static readonly Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
  static readonly Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
  static readonly Guid MFMediaType_Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
  static readonly Guid MFVideoFormat_RGB32 = new Guid("00000016-0000-0010-8000-00AA00389B71");
  /// NV12: 4:2:0 8-bit, Y plane then interleaved UV plane. Native decoder output on Windows.
  static readonly Guid MFVideoFormat_NV12 = new Guid("3231564E-0000-0010-8000-00AA00389B71");
  static readonly Guid MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING = new Guid("fb394f3d-ccf5-42ee-bbb3-f9b845d5681d");
  static readonly Guid MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING = new Guid("0f81da2c-b537-4672-a8b1-ae8f8c3c5f95");
  static readonly Guid MF_SOURCE_READER_FIRST_VIDEO_STREAM = new Guid("fbc9b8f3-6b2d-4c1e-0000-000000000000");
  static readonly Guid MF_SOURCE_READER_ANY_STREAM = new Guid("00000000-0000-0000-0000-000000000000");
  static readonly Guid MF_PD_DURATION = new Guid("6c990d33-bb8e-477a-8598-0d5d96fcd88a");
  static readonly Guid MF_SOURCE_READER_MEDIASOURCE = new Guid("e7fbc3f9-7b1c-4a2e-9d4b-000000000000");

  const int MF_VERSION = 0x00020070;
  const uint MF_SOURCE_READERF_ENDOFSTREAM = 0x2;
  const uint MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED = 0x4;
  const int MF_E_NO_MORE_TYPES = unchecked((int)0xC00D36B9);

  const uint VIDEO_STREAM = 0xFFFFFFFC; // MF_SOURCE_READER_FIRST_VIDEO_STREAM

  /// Sequential sampler: MF's SetCurrentPosition rejected every hand-built PROPVARIANT
  /// ("invalid argument" before the call even reached the reader), so instead of seeking we
  /// read the stream in order and keep, for each requested timestamp, the frame closest to
  /// it. Reading stops once every target is covered (plus a small tail) or a sane cap hits.
  /// Returns one entry per requested timestamp; entries stay null when never matched.
  static Bitmap[] ReadNearestFrames(IMFSourceReader reader, long[] targetsHns, bool debug) {
    int n = targetsHns.Length;
    var best = new Bitmap[n];
    var bestDelta = new long[n];
    var done = new bool[n];
    for (int i = 0; i < n; i++) { bestDelta[i] = long.MaxValue; }

    long maxTarget = 0;
    for (int i = 0; i < n; i++) { if (targetsHns[i] > maxTarget) { maxTarget = targetsHns[i]; } }
    long stopAt = maxTarget + 5000000; // 0.5s tail past the last target (hns)
    // Slot window: half the gap between targets (single target -> generous).
    long targetSpacing = n > 1 ? Math.Abs(targetsHns[1] - targetsHns[0]) : 4000000;
    int remaining = n;
    int samples = 0;

    while (samples < 6000) {
      uint actualStream, flags;
      long ts;
      IMFSample sample;
      int hr = reader.ReadSample(VIDEO_STREAM, 0, out actualStream, out flags, out ts, out sample);
      if (hr < 0) { break; }
      if ((flags & MF_SOURCE_READERF_ENDOFSTREAM) != 0) {
        if (sample != null) { Marshal.ReleaseComObject(sample); }
        break;
      }
      samples++;
      if (sample == null) { continue; }
      if (debugSamples) {
        Console.Error.WriteLine("dbg:   sample ts=" + (ts / 10000.0) + "ms flags=0x" + flags.ToString("X"));
      }
      try {
        // Only decode when this sample can actually win a slot: decoding is the expensive part.
        // bestDelta is updated ONLY after a successful decode -- updating it up front let a
        // failed first decode (ts=0) lock a target permanently, leaving that tile empty.
        int hit = -1;
        long hitDelta = long.MaxValue;
        // Each slot only accepts samples inside its own window. Without this, sequential
        // reading makes every target latch onto the earliest/nearest sample and, when the
        // reported duration overruns the real stream, several tiles end up identical.
        long window = targetSpacing / 2;
        if (window < 4000000) { window = 4000000; } // never tighter than 0.4s
        for (int i = 0; i < n; i++) {
          if (done[i]) { continue; }
          long apart = ts - targetsHns[i];
          if (apart < 0) { apart = -apart; }
          if (apart > window) { continue; }
          if (apart < bestDelta[i] && apart < hitDelta) { hit = i; hitDelta = apart; }
        }
        if (hit >= 0) {
          Bitmap bmp = Decode(sample);
          if (bmp != null) {
            bestDelta[hit] = hitDelta;
            done[hit] = true;
            if (best[hit] != null) { best[hit].Dispose(); }
            best[hit] = bmp;
          } else if (debug) {
            Console.Error.WriteLine("dbg:   decode failed for target " + (targetsHns[hit] / 10000000.0) + "s (will retry)");
          }
        }
        if (ts > stopAt) { break; }
      } finally {
        Marshal.ReleaseComObject(sample);
      }
    }

    if (debug) {
      for (int i = 0; i < n; i++) {
        Console.Error.WriteLine("dbg:   target " + (targetsHns[i] / 10000000.0) + "s -> "
          + (best[i] == null ? "none" : best[i].Width + "x" + best[i].Height)
          + " delta=" + (bestDelta[i] == long.MaxValue ? "-" : (bestDelta[i] / 10000.0) + "ms"));
      }
    }

    // The duration WeChat reports can exceed what the stream actually decodes (observed:
    // an 8s report whose last target never arrived, leaving a black tile). Fill missing
    // slots by cloning an existing frame so the grid never ships a blank cell; prefer the
    // nearest later frame, else the nearest earlier one.
    for (int i = 0; i < n; i++) {
      if (best[i] != null) { continue; }
      int donor = -1;
      for (int j = i + 1; j < n && donor < 0; j++) { if (best[j] != null) { donor = j; } }
      for (int j = i - 1; j >= 0 && donor < 0; j--) { if (best[j] != null) { donor = j; } }
      if (donor >= 0) {
        best[i] = (Bitmap)best[donor].Clone();
        if (debug) {
          Console.Error.WriteLine("dbg:   slot " + i + " had no frame; cloned from slot " + donor);
        }
      }
    }
    return best;
  }

  /// Convert one NV12 sample into a Bitmap. Bounds-checked against the real buffer length:
  /// the decoder may hand back a different size than requested, and over-reading crashes.
  static Bitmap Decode(IMFSample sample) {
    IMFMediaBuffer buf;
    if (sample.ConvertToContiguousBuffer(out buf) < 0 || buf == null) { return null; }
    try {
      IntPtr p;
      uint maxLen, curLen;
      if (buf.Lock(out p, out maxLen, out curLen) < 0) { return null; }
      try {
        int width = widthHint, height = heightHint;
        if (width <= 0 || height <= 0) { return null; }
        long need = (long)width * height + (long)width * ((height + 1) / 2); // Y + interleaved UV
        if (curLen < need) {
          if (debugDecode) { Console.Error.WriteLine("dbg: decode skip curLen=" + curLen + " need=" + need + " " + width + "x" + height); }
          return null;
        }
        return Nv12ToBitmap(p, width, height);
      } finally {
        buf.Unlock();
      }
    } finally {
      Marshal.ReleaseComObject(buf);
    }
  }

  /// BT.601 studio-swing NV12 -> 32bppRgb (what the video processor MFT would produce).
  /// Managed arrays rather than pointers: Windows PowerShell 5.1's Add-Type has no
  /// -CompilerOptions, so /unsafe is unavailable and pointer code will not compile.
  static Bitmap Nv12ToBitmap(IntPtr p, int width, int height) {
    int ySize = width * height;
    int uvSize = width * ((height + 1) / 2);
    var src = new byte[ySize + uvSize];
    Marshal.Copy(p, src, 0, src.Length);

    var bmp = new Bitmap(width, height, PixelFormat.Format32bppRgb);
    var data = bmp.LockBits(new Rectangle(0, 0, width, height),
                            ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
    try {
      var row = new byte[width * 4];
      for (int y = 0; y < height; y++) {
        int yBase = y * width;
        int uvBase = ySize + (y / 2) * width;
        int c = 0;
        for (int x = 0; x < width; x++) {
          int Y = src[yBase + x] - 16;
          if (Y < 0) { Y = 0; }
          int u = src[uvBase + c] - 128;
          int v = src[uvBase + c + 1] - 128;
          int r = (298 * Y + 409 * v + 128) >> 8;
          int g = (298 * Y - 100 * u - 208 * v + 128) >> 8;
          int b = (298 * Y + 516 * u + 128) >> 8;
          row[x * 4 + 0] = (byte)(b < 0 ? 0 : (b > 255 ? 255 : b));
          row[x * 4 + 1] = (byte)(g < 0 ? 0 : (g > 255 ? 255 : g));
          row[x * 4 + 2] = (byte)(r < 0 ? 0 : (r > 255 ? 255 : r));
          row[x * 4 + 3] = 255;
          if ((x & 1) == 1) { c += 2; }
        }
        Marshal.Copy(row, 0, (IntPtr)((long)data.Scan0 + (long)y * data.Stride), row.Length);
      }
    } finally {
      bmp.UnlockBits(data);
    }
    return bmp;
  }

  /// Set once per session from the negotiated media type; guards Decode against size drift.
  static int widthHint = 0;
  static int heightHint = 0;
  /// Mirrors the Sheet debug flag so Decode can report why a sample was skipped.
  static bool debugDecode = false;
  /// Per-sample trace is extremely verbose; keep it behind its own switch.
  static bool debugSamples = false;

  static void ReadCurrentFrameSize(IMFSourceReader reader) {
    widthHint = 0;
    heightHint = 0;
    IMFMediaType cur;
    if (reader.GetCurrentMediaType(VIDEO_STREAM, out cur) < 0 || cur == null) { return; }
    try {
      Guid kFrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d"); // MF_MT_FRAME_SIZE
      ulong packed;
      if (cur.GetUINT64(ref kFrameSize, out packed) == 0) {
        widthHint = (int)(packed >> 32);
        heightHint = (int)(packed & 0xFFFFFFFF);
      }
    } finally {
      Marshal.ReleaseComObject(cur);
    }
  }

  /// Human-readable subtype of the current video media type (diagnostics only).
  static string SubtypeName(IMFSourceReader reader) {
    IMFMediaType cur;
    if (reader.GetCurrentMediaType(VIDEO_STREAM, out cur) < 0 || cur == null) { return "(none)"; }
    try {
      Guid kSub = MF_MT_SUBTYPE;
      Guid got;
      if (cur.GetGUID(ref kSub, out got) != 0) { return "(unknown)"; }
      return got.ToString();
    } finally {
      Marshal.ReleaseComObject(cur);
    }
  }

  [DllImport("kernel32.dll", EntryPoint = "RtlMoveMemory")]
  static extern void CopyMemory(IntPtr dest, IntPtr src, uint count);

  /// Run the whole MF session on an MTA thread; return the tile grid as a Bitmap.
  public static Bitmap Sheet(string path, double[] seconds, int columns,
                             int captureW, int captureH, int tileW, int tileH, bool debug) {
    Bitmap sheet = null;
    Exception failure = null;
    var worker = new Thread(() => {
      IMFSourceReader reader = null;
      try {
        int hr = MFStartup(MF_VERSION, 0);
        if (debug) { Console.Error.WriteLine("dbg: MFStartup hr=0x" + hr.ToString("X8")); }
        if (hr < 0) { throw new Exception("MFStartup failed 0x" + hr.ToString("X8")); }

        IMFAttributes attrs = null;
        // A native attribute store with video processing enabled is what makes the source
        // reader accept RGB32 (it inserts the video processor MFT for color conversion).
        hr = MFCreateAttributes(out attrs, 1);
        if (debug) { Console.Error.WriteLine("dbg: MFCreateAttributes hr=0x" + hr.ToString("X8")); }
        if (hr < 0) { throw new Exception("MFCreateAttributes failed 0x" + hr.ToString("X8")); }
        Guid kEnableVp = MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING;
        attrs.SetUINT32(ref kEnableVp, 1);
        if (debug) { Console.Error.WriteLine("dbg: attrs ready (video processing on)"); }

        hr = MFCreateSourceReaderFromURL(path, attrs, out reader);
        if (debug) { Console.Error.WriteLine("dbg: create reader hr=0x" + hr.ToString("X8")); }
        if (hr < 0) { throw new Exception("MFCreateSourceReaderFromURL failed 0x" + hr.ToString("X8")); }

        // Ask for NV12: that is what Windows decoders natively output, and unlike RGB32 it
        // is accepted without the video processor MFT. Convert to RGB in managed code.
        IMFMediaType mt;
        if (MFCreateMediaType(out mt) < 0) { throw new Exception("MFCreateMediaType failed"); }
        Guid kMajor = MF_MT_MAJOR_TYPE;
        Guid kSub = MF_MT_SUBTYPE;
        Guid kVideo = MFMediaType_Video;
        Guid kSubtype = MFVideoFormat_NV12;
        mt.SetGUID(ref kMajor, ref kVideo);
        mt.SetGUID(ref kSub, ref kSubtype);
        if (debug) { Console.Error.WriteLine("dbg: media type attrs set (NV12)"); }
        hr = reader.SetCurrentMediaType(VIDEO_STREAM, IntPtr.Zero, mt);
        if (debug) { Console.Error.WriteLine("dbg: set media type hr=0x" + hr.ToString("X8")); }
        if (hr < 0) {
          if (debug) {
            Console.Error.WriteLine("dbg: native types follow");
            for (uint i = 0; i < 8; i++) {
              IMFMediaType n;
              int h = reader.GetNativeMediaType(VIDEO_STREAM, i, out n);
              if (h < 0 || n == null) { Console.Error.WriteLine("dbg:   [" + i + "] none (0x" + h.ToString("X8") + ")"); break; }
              Guid ks = MF_MT_SUBTYPE;
              Guid kfs = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
              Guid sub; ulong fs;
              string fsText = "?";
              if (n.GetUINT64(ref kfs, out fs) == 0) { fsText = (fs >> 32) + "x" + (fs & 0xFFFFFFFF); }
              Console.Error.WriteLine("dbg:   [" + i + "] sub=" + (n.GetGUID(ref ks, out sub) == 0 ? sub.ToString() : "?") + " size=" + fsText);
              Marshal.ReleaseComObject(n);
            }
          }
          throw new Exception("SetCurrentMediaType(NV12) failed 0x" + hr.ToString("X8"));
        }
        Marshal.ReleaseComObject(mt);

        // The negotiated output size drives the buffer copy; never assume the request won.
        ReadCurrentFrameSize(reader);
        if (debug) { Console.Error.WriteLine("dbg: frame size " + widthHint + "x" + heightHint); Console.Error.WriteLine("dbg: subtype " + SubtypeName(reader)); }
        if (widthHint <= 0 || heightHint <= 0) {
          throw new Exception("could not determine decoded frame size");
        }

        int cols = Math.Max(1, columns);
        int rows = (int)Math.Ceiling(seconds.Length / (double)cols);
        debugDecode = debug;
        sheet = new Bitmap(cols * tileW, rows * tileH, PixelFormat.Format32bppRgb);
        using (var g = Graphics.FromImage(sheet)) { g.Clear(Color.Black); }

        var targets = new long[seconds.Length];
        for (int i = 0; i < seconds.Length; i++) { targets[i] = (long)(seconds[i] * 10000000.0); }
        if (debug) {
          Console.Error.WriteLine("dbg: targets hns = " + string.Join(",", Array.ConvertAll(targets, v => v.ToString())));
        }
        Bitmap[] frames = ReadNearestFrames(reader, targets, debug);

        int placed = 0;
        for (int i = 0; i < frames.Length; i++) {
          var frame = frames[i];
          if (frame == null) { continue; }
          try {
            using (var g = Graphics.FromImage(sheet)) {
              g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
              g.DrawImage(frame, new Rectangle((i % cols) * tileW, (i / cols) * tileH, tileW, tileH));
            }
            placed++;
          } finally {
            frame.Dispose();
          }
        }
        if (debug) { Console.Error.WriteLine("dbg: placed " + placed + "/" + frames.Length); }
        if (placed == 0) { sheet = null; }
      } catch (Exception ex) {
        failure = ex;
      } finally {
        if (reader != null) { Marshal.ReleaseComObject(reader); }
        MFShutdown();
      }
    });
    worker.SetApartmentState(ApartmentState.MTA);
    worker.Start();
    worker.Join();
    if (failure != null) { throw failure; }
    return sheet;
  }
}

/// Minimal IMFAttributes implementation for MFCreateSourceReaderFromURL.
/// GetUINT32 must really return what SetUINT32 stored: the source reader reads
/// MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING back off this object, and a stub that
/// always fails leaves the video processor off (no RGB32, no scaling).
public class MFAttributesImpl : MfFrames.IMFAttributes {
  readonly Dictionary<Guid, uint> u32 = new Dictionary<Guid, uint>();

  public int GetItem(ref Guid guidKey, IntPtr pValue) { return unchecked((int)0x80004001); }
  public int GetItemType(ref Guid guidKey, out int pType) { pType = u32.ContainsKey(guidKey) ? 19 : 0; return 0; }
  public int CompareItem(ref Guid guidKey, IntPtr value, out bool pbResult) { pbResult = false; return unchecked((int)0x80004001); }
  public int Compare(MfFrames.IMFAttributes pTheirs, int matchType, out bool pbResult) { pbResult = false; return unchecked((int)0x80004001); }
  public int GetUINT32(ref Guid guidKey, out uint pnValue) {
    if (u32.TryGetValue(guidKey, out pnValue)) { return 0; }
    pnValue = 0; return unchecked((int)0x80070002); // HRESULT_FROM_WIN32(ERROR_NOT_FOUND)
  }
  public int GetUINT64(ref Guid guidKey, out ulong pnValue) { pnValue = 0; return unchecked((int)0x80070002); }
  public int GetDouble(ref Guid guidKey, out double pfValue) { pfValue = 0; return unchecked((int)0x80070002); }
  public int GetGUID(ref Guid guidKey, out Guid pguidValue) { pguidValue = Guid.Empty; return unchecked((int)0x80070002); }
  public int GetStringLength(ref Guid guidKey, out uint pcchLength) { pcchLength = 0; return unchecked((int)0x80070002); }
  public int GetString(ref Guid guidKey, IntPtr pwszValue, uint cchBufSize, IntPtr pcchLength) { return unchecked((int)0x80070002); }
  public int GetAllocatedString(ref Guid guidKey, out IntPtr ppwszValue, out uint pcchLength) { ppwszValue = IntPtr.Zero; pcchLength = 0; return unchecked((int)0x80070002); }
  public int GetBlobSize(ref Guid guidKey, out uint pcbBlobSize) { pcbBlobSize = 0; return unchecked((int)0x80070002); }
  public int GetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize, IntPtr pcbBlobSize) { return unchecked((int)0x80070002); }
  public int GetAllocatedBlob(ref Guid guidKey, out IntPtr ppBuf, out uint pcbSize) { ppBuf = IntPtr.Zero; pcbSize = 0; return unchecked((int)0x80070002); }
  public int GetUnknown(ref Guid guidKey, ref Guid riid, out IntPtr ppv) { ppv = IntPtr.Zero; return unchecked((int)0x80070002); }
  public int SetItem(ref Guid guidKey, IntPtr Value) { return 0; }
  public int DeleteItem(ref Guid guidKey) { u32.Remove(guidKey); return 0; }
  public int DeleteAllItems() { u32.Clear(); return 0; }
  public int SetUINT32(ref Guid guidKey, uint unValue) { u32[guidKey] = unValue; return 0; }
  public int SetUINT64(ref Guid guidKey, ulong unValue) { return 0; }
  public int SetDouble(ref Guid guidKey, double fValue) { return 0; }
  public int SetGUID(ref Guid guidKey, ref Guid guidValue) { return 0; }
  public int SetString(ref Guid guidKey, string wszValue) { return 0; }
  public int SetBlob(ref Guid guidKey, IntPtr pBuf, uint cbBufSize) { return 0; }
  public int SetUnknown(ref Guid guidKey, object pUnknown) { return 0; }
  public int LockStore() { return 0; }
  public int UnlockStore() { return 0; }
  public int GetCount(out uint pcItems) { pcItems = (uint)u32.Count; return 0; }
  public int GetItemByIndex(uint unIndex, out Guid pguidKey, IntPtr pValue) { pguidKey = Guid.Empty; return unchecked((int)0x80070002); }
  public int CopyAllItems(MfFrames.IMFAttributes pDest) { return 0; }
}
'@ -ReferencedAssemblies System.Drawing

  $offsets = @($Seconds.Split(',') | ForEach-Object { [double]$_.Trim() } | Where-Object { $_ -ge 0 })
  if ($offsets.Count -eq 0) {
    [Console]::Error.WriteLine('no valid timestamps given')
    exit 3
  }

  $sheet = [MfFrames]::Sheet($Path, [double[]]$offsets, $Columns, $CaptureWidth, $CaptureHeight, $TileWidth, $TileHeight, ($env:DSH_MF_DEBUG -eq '1'))
  if ($null -eq $sheet) {
    [Console]::Error.WriteLine('MF produced no frames')
    exit 2
  }

  $dir = Split-Path -Parent $Out
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $sheet.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $w = $sheet.Width; $h = $sheet.Height
  $sheet.Dispose()

  $len = (Get-Item -LiteralPath $Out).Length
  Write-Output "ok $Out $len sheet=${w}x${h} requested=$($offsets.Count)"
  exit 0
}
catch {
  [Console]::Error.WriteLine("mf frames failed: $($_.Exception.Message)")
  exit 3
}
