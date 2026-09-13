$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$frontendRoot = Split-Path -Parent $PSScriptRoot
$installerDirectory = Join-Path $frontendRoot "electron\installer"
$logoPath = Join-Path $frontendRoot "public\brand\voltchat-transparent.png"
$iconPath = Join-Path $frontendRoot "public\brand\voltchat-favicon.png"
$desktopIconPath = Join-Path $frontendRoot "electron\assets\icon.ico"
New-Item -ItemType Directory -Path $installerDirectory -Force | Out-Null

function New-Brush {
  param([string]$Hex)
  return [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($Hex))
}

function Draw-ContainedImage {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$ImagePath,
    [float]$X,
    [float]$Y,
    [float]$Width,
    [float]$Height
  )

  $image = [System.Drawing.Image]::FromFile($ImagePath)
  try {
    $scale = [Math]::Min($Width / $image.Width, $Height / $image.Height)
    $drawWidth = $image.Width * $scale
    $drawHeight = $image.Height * $scale
    $drawX = $X + (($Width - $drawWidth) / 2)
    $drawY = $Y + (($Height - $drawHeight) / 2)
    $Graphics.DrawImage($image, $drawX, $drawY, $drawWidth, $drawHeight)
  } finally {
    $image.Dispose()
  }
}

function Save-InstallerSidebar {
  param([string]$Path)

  $bitmap = [System.Drawing.Bitmap]::new(164, 314)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $graphics.Clear([System.Drawing.Color]::White)
  Draw-ContainedImage -Graphics $graphics -ImagePath $iconPath -X 20 -Y 34 -Width 124 -Height 124
  Draw-ContainedImage -Graphics $graphics -ImagePath $logoPath -X 10 -Y 165 -Width 144 -Height 58

  $smallFont = [System.Drawing.Font]::new("Segoe UI", 8.5, [System.Drawing.FontStyle]::Bold)
  $graphics.DrawString("Instalador interno", $smallFont, (New-Brush "#64748B"), 30, 238)
  $graphics.DrawString("VoltChat", $smallFont, (New-Brush "#0F172A"), 50, 258)
  $smallFont.Dispose()

  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $graphics.Dispose()
  $bitmap.Dispose()
}

function Save-DesktopIcon {
  param([string]$Path)

  $bitmap = [System.Drawing.Bitmap]::new(256, 256)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.Clear([System.Drawing.Color]::Transparent)
  Draw-ContainedImage -Graphics $graphics -ImagePath $iconPath -X 0 -Y 0 -Width 256 -Height 256

  $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
  $stream = [System.IO.File]::Create($Path)
  try {
    $icon.Save($stream)
  } finally {
    $stream.Dispose()
    $icon.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Save-InstallerHeader {
  param([string]$Path)

  $bitmap = [System.Drawing.Bitmap]::new(150, 57)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

  $graphics.Clear([System.Drawing.Color]::White)
  Draw-ContainedImage -Graphics $graphics -ImagePath $logoPath -X 8 -Y 6 -Width 134 -Height 45

  $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $graphics.Dispose()
  $bitmap.Dispose()
}

Save-InstallerSidebar -Path (Join-Path $installerDirectory "sidebar.bmp")
Save-InstallerHeader -Path (Join-Path $installerDirectory "header.bmp")
Save-DesktopIcon -Path $desktopIconPath

Write-Host "Assets e icone do VoltChat gerados em $installerDirectory"
