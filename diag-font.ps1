Add-Type -AssemblyName System.Drawing
$bmp = New-Object Drawing.Bitmap 600, 900
$bmp.SetResolution(72, 72)
$g = [Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [Drawing.Text.TextRenderingHint]::ClearTypeGridFit

$f1 = New-Object Drawing.Font('Microsoft YaHei', 24, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
"Font: height=$($f1.Height) size=$($f1.Size) unit=$($f1.Unit)"
foreach ($t in @('忙', '在吗 你怎么一直不回我', '我只是希望你忙的时候说一声')) {
  $s1 = $g.MeasureString($t, $f1)
  $s2 = $g.MeasureString($t, $f1, (New-Object Drawing.SizeF(9999, 999)), [Drawing.StringFormat]::GenericTypographic)
  "text=[$t] default=$([int]$s1.Width)x$([int]$s1.Height) typo=$([int]$s2.Width)x$([int]$s2.Height)"
}
$f1.Dispose(); $g.Dispose(); $bmp.Dispose()
