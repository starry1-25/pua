# 生成固定 OCR 测试集（与浏览器端 Tesseract 基线同图）
Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot 'fixtures'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-Bitmap($w, $h) {
  $bmp = New-Object Drawing.Bitmap $w, $h
  $bmp.SetResolution(72, 72)
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  return $bmp, $g
}

function Round-Path($x, $y, $w, $h, $r) {
  $p = New-Object Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Draw-Time($g, $text, $cx, $y) {
  $f = New-Object Drawing.Font('Microsoft YaHei', 14, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
  $b = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(153, 153, 153))
  $sf = New-Object Drawing.StringFormat
  $sf.Alignment = [Drawing.StringAlignment]::Center
  $rect = New-Object Drawing.RectangleF -ArgumentList @([single]0, [single]$y, [single]($cx * 2), [single]40)
  $g.DrawString($text, $f, $b, $rect, $sf)
  $f.Dispose(); $b.Dispose()
}

function Draw-Bubble($g, $side, $lines, $y, $W) {
  $font = New-Object Drawing.Font('Microsoft YaHei', 24, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
  $lineH = 38; $padX = 20; $padY = 18
  $maxW = 0
  foreach ($t in $lines) {
    $textW = [int][Math]::Ceiling($g.MeasureString($t, $font).Width)
    if ($textW -gt $maxW) { $maxW = $textW }
  }
  $bw = $maxW + $padX * 2
  if ($bw -gt $W - 48) { $bw = $W - 48 }
  $bh = $lineH * $lines.Count + $padY * 2 - 6
  $bx = if ($side -eq 'right') { $W - 24 - $bw } else { 24 }
  $path = Round-Path $bx $y $bw $bh 10
  if ($side -eq 'right') {
    $brush = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(63, 111, 107))
  } else {
    $brush = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
  }
  $g.FillPath($brush, $path)
  $tb = if ($side -eq 'right') {
    New-Object Drawing.SolidBrush ([Drawing.Color]::White)
  } else {
    New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(34, 34, 34))
  }
  $sf = New-Object Drawing.StringFormat
  $sf.Alignment = [Drawing.StringAlignment]::Near
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $rect = New-Object Drawing.RectangleF -ArgumentList @([single]($bx + $padX), [single]($y + $padY + $i * $lineH - 2), [single]($maxW + 4), [single]$lineH)
    $g.DrawString($lines[$i], $font, $tb, $rect, $sf)
  }
  $font.Dispose(); $brush.Dispose(); $tb.Dispose(); $path.Dispose()
  return $bh + 24
}

# ===== A 图：单字气泡压力测试 =====
$W = 600; $H = 900
$bmp, $g = New-Bitmap $W $H
$g.Clear([Drawing.Color]::FromArgb(237, 237, 237))
Draw-Time $g '21:03' ($W / 2) 22
$y = 78
$y += Draw-Bubble $g 'left'  @('在吗 你怎么一直不回我') $y $W
$y += Draw-Bubble $g 'right' @('忙') $y $W
$y += Draw-Bubble $g 'left'  @('你能不能别这么敏感') $y $W
$y += Draw-Bubble $g 'right' @('我只是希望你忙的时候说一声') $y $W
$y += Draw-Bubble $g 'left'  @('好的知道了') $y $W
$bmp.Save((Join-Path $dir 'A_single_char.png'), [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ===== B 图：多行气泡 + 系统提示 + 长句 =====
$W = 600; $H = 1000
$bmp, $g = New-Bitmap $W $H
$g.Clear([Drawing.Color]::FromArgb(237, 237, 237))
Draw-Time $g '昨天 21:40' ($W / 2) 22
$y = 78
$y += Draw-Bubble $g 'left'  @('这个项目周五就要交', '你那边进度怎么样了') $y $W
$y += Draw-Bubble $g 'right' @('还差一点，今晚加班能做完') $y $W
# 系统提示（居中灰字）
Draw-Time $g '对方撤回了一条消息' ($W / 2) $y
$y += 46
$y += Draw-Bubble $g 'right' @('刚发错了。明天上午十点的评审会别忘了，') $y $W
$y += Draw-Bubble $g 'left'  @('知道了') $y $W
$bmp.Save((Join-Path $dir 'B_multiline.png'), [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# ===== C 图：数字/英文/标点/道歉长文 =====
$W = 600; $H = 1000
$bmp, $g = New-Bitmap $W $H
$g.Clear([Drawing.Color]::FromArgb(237, 237, 237))
Draw-Time $g '9月15日 09:12' ($W / 2) 22
$y = 78
$y += Draw-Bubble $g 'right' @('报表第3页的 Q3 数据不对，') $y $W
$y += Draw-Bubble $g 'left'  @('对不起，是我没核对清楚，马上改') $y $W
$y += Draw-Bubble $g 'right' @('每次都这样，能不能上点心？') $y $W
$y += Draw-Bubble $g 'left'  @('真的抱歉，11:30 前重新发你一版') $y $W
$y += Draw-Bubble $g 'right' @('嗯') $y $W
$bmp.Save((Join-Path $dir 'C_mixed.png'), [Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Get-ChildItem $dir -Filter *.png | ForEach-Object { "$($_.Name) $($_.Length) bytes" }
