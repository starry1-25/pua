# 用 Agnes AI 视觉模型识别 fixtures 下的测试图
param([string]$Model = '', [string]$Only = '')
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$fixtures = Join-Path $root 'fixtures'

# 从 .env 读 key / base_url / 默认模型（环境变量优先）
$envFile = Join-Path (Split-Path $root -Parent) '.env'
if (Test-Path $envFile) {
  Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$') {
      $k = $Matches[1]; $v = $Matches[2].Trim('"').Trim("'")
      if (-not [Environment]::GetEnvironmentVariable($k)) { [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
    }
  }
}
$key = [Environment]::GetEnvironmentVariable('AI_API_KEY')
if (-not $key) { throw '未找到 AI_API_KEY' }
$baseUrl = ([Environment]::GetEnvironmentVariable('AI_BASE_URL')).TrimEnd('/')
if (-not $baseUrl) { $baseUrl = 'https://api.agnes-ai.cn/v1' }
if (-not $Model) { $Model = [Environment]::GetEnvironmentVariable('AI_VISION_MODEL') }
if (-not $Model) { $Model = 'agnes-3.0-flash' }

$prompt = @'
这是一张手机聊天App截图。请逐气泡识别并判定方位：
- 位于屏幕左侧的气泡 side="left"，位于屏幕右侧的气泡 side="right"
- 忽略时间戳、系统提示（如撤回提示）、头像、昵称等非对话内容
- 同一气泡内的多行文字合并为一个 text，保留换行
严格只输出 JSON，不要输出任何解释：
{"messages":[{"side":"left","text":"内容"},{"side":"right","text":"内容"}]}
顺序按从上到下。
'@

function Invoke-WithRetry($bodyJson, $maxTry) {
  for ($i = 1; $i -le $maxTry; $i++) {
    try {
      # 注意：PS 5.1 的 Invoke-RestMethod 在响应缺 charset 时会按 Latin1 解码导致中文乱码，
      # 这里用 HttpWebRequest + UTF8 StreamReader 显式解码
      $req = [Net.HttpWebRequest]::Create("$baseUrl/chat/completions")
      $req.Method = 'POST'
      $req.Accept = 'application/json'
      $req.ContentType = 'application/json; charset=utf-8'
      $req.Headers.Add('Authorization', "Bearer $key")
      $req.Timeout = 90000
      $bodyBytes = [Text.Encoding]::UTF8.GetBytes($bodyJson)
      $req.ContentLength = $bodyBytes.Length
      $rs = $req.GetRequestStream(); $rs.Write($bodyBytes, 0, $bodyBytes.Length); $rs.Close()
      $resp = $req.GetResponse()
      $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)
      $respTxt = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
      return ($respTxt | ConvertFrom-Json)
    } catch {
      $code = $null
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      if (($code -eq 429 -or $code -ge 500) -and $i -lt $maxTry) {
        $wait = 20 * $i + 15
        Write-Host "  HTTP $code，${wait}s 后重试（第 $i/$maxTry 次）"
        Start-Sleep -Seconds $wait
      } else { throw }
    }
  }
}

$results = @{}
$files = Get-ChildItem $fixtures -Filter *.png | Sort-Object Name
if ($Only) { $files = $files | Where-Object { $_.Name -like "*$Only*" } }
for ($fi = 0; $fi -lt $files.Count; $fi++) {
  $_ = $files[$fi]
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($_.FullName))
  $body = @{
    model = $Model
    temperature = 0.05
    max_tokens = 2000
    messages = @(@{
      role = 'user'
      content = @(
        @{ type = 'image_url'; image_url = @{ url = "data:image/png;base64,$b64" } },
        @{ type = 'text'; text = $prompt }
      )
    })
  } | ConvertTo-Json -Depth 8 -Compress

  Write-Host "=== $($_.Name) ==="
  try {
    $r = Invoke-WithRetry $body 6
    $content = $r.choices[0].message.content
    Write-Host $content
    $results[$_.Name] = $content
  } catch {
    Write-Host "ERROR: $($_.Exception.Message)"
    if ($_.ErrorDetails) { Write-Host $_.ErrorDetails.Message }
  }
  if ($fi -lt $files.Count - 1) { Start-Sleep -Seconds 8 }
}
$results | ConvertTo-Json -Depth 5 | Out-File (Join-Path $root 'out-cloud.json') -Encoding UTF8
