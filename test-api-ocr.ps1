param([string]$Only = 'A_single_char')
$imgPath = "d:\AI_vibecoding\PUA\tests\fixtures\$Only.png"
$bytes = [IO.File]::ReadAllBytes($imgPath)
$b64 = [Convert]::ToBase64String($bytes)
$body = @{ image = ('data:image/png;base64,' + $b64) } | ConvertTo-Json -Compress

for ($attempt = 1; $attempt -le 6; $attempt++) {
  try {
    Write-Host "=== attempt $attempt ($Only) ==="
    $r = Invoke-RestMethod -Uri http://localhost:8165/api/ocr -Method Post -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 120
    Write-Host ('MODEL: ' + $r.model)
    Write-Host $r.content
    exit 0
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    Write-Host "FAIL code=$code $($_.Exception.Message)"
    if ($code -eq 429 -or $code -ge 500) {
      $wait = 20 * $attempt + 10
      Write-Host "rate limited, sleep $wait s"
      Start-Sleep $wait
      continue
    }
    try { $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream()); Write-Host $sr.ReadToEnd() } catch {}
    exit 1
  }
}
Write-Host 'giving up after retries'
exit 1
