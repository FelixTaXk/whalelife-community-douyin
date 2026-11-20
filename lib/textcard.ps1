param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$OutFile
)

Add-Type -AssemblyName System.Drawing

$raw = ''
if (Test-Path -LiteralPath $TextFile) { $raw = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8 }
if ([string]::IsNullOrWhiteSpace($raw)) { $raw = ' ' }
$raw = $raw.Trim()

$W = 1080
$H = 1440
$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

$rect = New-Object System.Drawing.Rectangle(0, 0, $W, $H)
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(26, 26, 31), [System.Drawing.Color]::FromArgb(9, 9, 12), 40)
$g.FillRectangle($bg, $rect)

$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 254, 44, 85))
$g.FillRectangle($accent, 96, 250, 96, 5)

$fontName = 'Microsoft YaHei'
$installed = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
if (-not ($installed -contains $fontName)) { $fontName = 'SimHei' }
if (-not ($installed -contains $fontName)) { $fontName = 'Arial' }

$bodyFont = New-Object System.Drawing.Font($fontName, 46, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$footFont = New-Object System.Drawing.Font($fontName, 26, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240, 240, 246))
$gray = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 150, 160))

function Wrap-Lines($graphics, $text, $font, $maxWidth) {
  $out = @()
  foreach ($para in ($text -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($para)) { $out += ''; continue }
    $cur = ''
    foreach ($ch in $para.ToCharArray()) {
      $trial = $cur + $ch
      $w = $graphics.MeasureString($trial, $font).Width
      if ($w -gt $maxWidth -and $cur.Length -gt 0) {
        $out += $cur
        $cur = [string]$ch
      } else {
        $cur = $trial
      }
    }
    if ($cur.Length -gt 0) { $out += $cur }
  }
  return $out
}

$lines = Wrap-Lines $g $raw $bodyFont ($W - 200)
$maxLines = 14
if ($lines.Count -gt $maxLines) {
  $lines = $lines[0..($maxLines - 1)]
  $last = $lines[$maxLines - 1]
  if ($last.Length -gt 2) {
    $lines[$maxLines - 1] = $last.Substring(0, $last.Length - 2) + '...'
  }
}

$y = 330
foreach ($line in $lines) {
  if ($line -ne '') { $g.DrawString($line, $bodyFont, $white, 96, $y) }
  $y += 74
}

$stamp = (Get-Date).ToString('yyyy.MM.dd')
$g.DrawString($stamp, $footFont, $gray, 96, ($H - 140))

$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $OutFile
