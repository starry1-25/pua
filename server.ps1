# 情绪显微镜 · 零依赖一体化服务
# 静态文件 + Agnes AI API 代理（密钥仅从 .env / 环境变量读取，绝不出现在前端代码）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File server.ps1
param(
  [int]$Port = 0,
  [string]$Root = (Split-Path $MyInvocation.MyCommand.Path -Parent)
)
$ErrorActionPreference = 'Stop'

# ---------- 读取 .env ----------
$envFile = Join-Path $Root '.env'
if (Test-Path $envFile) {
  Get-Content $envFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) { return }
    $idx = $line.IndexOf('=')
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    if (-not [Environment]::GetEnvironmentVariable($k, 'Process')) {
      [Environment]::SetEnvironmentVariable($k, $v, 'Process')
    }
  }
}
$pEnv = [Environment]::GetEnvironmentVariable('PORT', 'Process')
$bUrl = [Environment]::GetEnvironmentVariable('AI_BASE_URL', 'Process')
$tModel = [Environment]::GetEnvironmentVariable('AI_TEXT_MODEL', 'Process')
$vModel = [Environment]::GetEnvironmentVariable('AI_VISION_MODEL', 'Process')
$cfgPort = if ($Port) { $Port } elseif ($pEnv) { [int]$pEnv } else { 8165 }
if (-not $bUrl) { $bUrl = 'https://api.agnes-ai.cn/v1' }
if (-not $tModel) { $tModel = 'agnes-3.0-flash' }
if (-not $vModel) { $vModel = 'agnes-3.0-flash' }
$cfg = @{
  Root         = $Root
  Port         = $cfgPort
  ApiKey       = [Environment]::GetEnvironmentVariable('AI_API_KEY', 'Process')
  BaseUrl      = $bUrl
  TextModel    = $tModel
  VisionModel  = $vModel
}

# ---------- 请求处理脚本（运行在线程池中） ----------
$handler = {
  param($ctx, $appCfg)
  $root = $appCfg.Root
  function Send-Bytes($ctx, [byte[]]$bytes, [string]$contentType, [int]$status = 200, [string]$cache = 'no-cache, no-store, must-revalidate') {
    $r = $ctx.Response
    $r.StatusCode = $status
    $r.ContentType = $contentType
    $r.Headers['Cache-Control'] = $cache
    $r.ContentLength64 = $bytes.Length
    $r.OutputStream.Write($bytes, 0, $bytes.Length)
  }
  function Send-Json($ctx, $obj, [int]$status = 200) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 12 -Compress))
    Send-Bytes $ctx $bytes 'application/json; charset=utf-8' $status
  }
  function Write-ApiLog([string]$event) {
    # API 调用审计日志：只记元数据（时间/路径/上游状态/模型/耗时），绝不记录聊天内容与图片数据
    try {
      [IO.File]::AppendAllText((Join-Path $appCfg.Root 'api-calls.log'),
        ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $event + "`n"), [Text.Encoding]::UTF8)
    } catch {}
  }
  function Read-Body($ctx, [int]$maxBytes) {
    $ms = New-Object IO.MemoryStream
    $buf = New-Object byte[] 65536
    $total = 0
    while ($true) {
      $n = $ctx.Request.InputStream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $total += $n
      if ($total -gt $maxBytes) { return $null }
      $ms.Write($buf, 0, $n)
    }
    return [Text.Encoding]::UTF8.GetString($ms.ToArray())
  }
  function Invoke-AI($path, [string]$jsonBody, [int]$timeoutMs) {
    $url = $appCfg.BaseUrl.TrimEnd('/') + $path
    $req = [Net.HttpWebRequest]::Create($url)
    $req.Method = 'POST'
    $req.ContentType = 'application/json; charset=utf-8'
    $req.Accept = 'application/json'
    $req.Timeout = $timeoutMs
    $req.ReadWriteTimeout = $timeoutMs
    $req.Headers.Add('Authorization', 'Bearer ' + $appCfg.ApiKey)
    $bytes = [Text.Encoding]::UTF8.GetBytes($jsonBody)
    $req.ContentLength = $bytes.Length
    try {
      $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
      $resp = $req.GetResponse()
      $rs = $resp.GetResponseStream()
      $sr = New-Object IO.StreamReader($rs, [Text.Encoding]::UTF8)
      $txt = $sr.ReadToEnd(); $sr.Close(); $resp.Close()
      return @{ Status = 200; Body = $txt }
    } catch [Net.WebException] {
      $resp = $_.Exception.Response
      if ($resp) {
        try {
          $rs = $resp.GetResponseStream()
          $sr = New-Object IO.StreamReader($rs, [Text.Encoding]::UTF8)
          $txt = $sr.ReadToEnd(); $sr.Close()
          $st = [int]$resp.StatusCode
          # 鉴权/计费/模型类错误：转成可操作的中文提示，前端可直接展示排查
          if ($st -eq 401 -or $st -eq 403 -or $st -eq 402 -or $st -eq 404) {
            $orig = ''
            try { $ej = $txt | ConvertFrom-Json; if ($ej.error -and $ej.error.message) { $orig = [string]$ej.error.message } } catch {}
            $hint = if ($st -eq 401) {
              '云端 AI 密钥无效或已失效（401 未授权）：请到 platform.agnes-ai.com 检查密钥是否完整/已被删除，更新 .env 的 AI_API_KEY 后重启服务'
            } elseif ($st -eq 403) {
              '云端 AI 拒绝访问（403）：当前密钥没有该模型或接口的调用权限'
            } elseif ($st -eq 402) {
              '云端 AI 账户余额或订阅配额不足（402）：请检查平台余额与 Token Plan 状态'
            } else {
              '云端 AI 模型或接口不存在（404）：请核对 .env 中 AI_TEXT_MODEL / AI_VISION_MODEL 的模型 ID'
            }
            if ($orig) { $hint = $hint + '（上游：' + ($orig -replace '\s+', ' ').Trim() + '）' }
            $txt = (@{ error = @{ status = $st; message = $hint } } | ConvertTo-Json -Depth 5 -Compress)
          } elseif ($st -eq 429 -or $st -ge 500) {
            # 限流/上游繁忙：给前端可识别的中文提示（保留上游原文便于排查）
            $orig = ''
            try { $ej = $txt | ConvertFrom-Json; if ($ej.error -and $ej.error.message) { $orig = [string]$ej.error.message } } catch {}
            $hint = if ($st -eq 429) {
              '云端 AI 当前请求过于频繁（429），已自动退避重试；若仍失败请稍等 1 分钟再点"重新调用云端生成"'
            } else {
              '云端 AI 服务繁忙或暂时异常（' + $st + '），已自动重试；可稍后点"重新调用云端生成"，本机备用内容仍可使用'
            }
            if ($orig) { $hint = $hint + '（上游：' + ($orig -replace '\s+', ' ').Trim().Substring(0, [Math]::Min(120, ($orig -replace '\s+', ' ').Trim().Length)) + '）' }
            $txt = (@{ error = @{ status = $st; message = $hint } } | ConvertTo-Json -Depth 5 -Compress)
          }
          return @{ Status = $st; Body = $txt }
        } catch { return @{ Status = 502; Body = '{"error":{"message":"上游错误且响应不可读"}}' } }
      }
      # 没有 HTTP 响应：按网络异常类型区分（超时不能与上游 502 混为一谈）
      $wStatus = $_.Exception.Status
      if ($wStatus -eq [Net.WebExceptionStatus]::Timeout -or $wStatus -eq [Net.WebExceptionStatus]::RequestCanceled) {
        return @{ Status = 504; Body = '{"error":{"status":504,"message":"云端 AI 响应超时（504）：上游生成时间过长，已自动重试；若反复出现请稍后再试，或先使用本机备用内容"}}' }
      }
      if ($wStatus -eq [Net.WebExceptionStatus]::ConnectFailure -or $wStatus -eq [Net.WebExceptionStatus]::NameResolutionFailure -or $wStatus -eq [Net.WebExceptionStatus]::ProxyNameResolutionFailure -or $wStatus -eq [Net.WebExceptionStatus]::KeepAliveFailure) {
        return @{ Status = 502; Body = ('{"error":{"status":502,"message":"无法连接云端 AI 服务（502 网络异常）：请检查本机网络与 .env 中 AI_BASE_URL：' + ($_.Exception.Message -replace '"', "'") + '"}}') }
      }
      return @{ Status = 502; Body = ('{{"error":{{"status":502,"message":"云端请求失败：{0}"}}}}' -f ($_.Exception.Message -replace '"', "'")) }
    }
  }

  try {
    $urlPath = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    $method = $ctx.Request.HttpMethod

    if ($method -eq 'OPTIONS') { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes('')) 'text/plain' 204; return }

    # ---------- API ----------
    if ($urlPath.StartsWith('/api/')) {
      if (-not $appCfg.ApiKey) {
        Send-Json $ctx @{ error = @{ message = '服务器未配置 AI_API_KEY，请在 .env 中设置后重启服务。' } } 503
        return
      }
      if ($urlPath -eq '/api/health') {
        Send-Json $ctx @{ ok = $true; engine = 'agnes-ai'; textModel = $appCfg.TextModel; visionModel = $appCfg.VisionModel; keyConfigured = $true }
        return
      }
      if ($urlPath -eq '/api/analyze' -and $method -eq 'POST') {
        $raw = Read-Body $ctx 262144
        if ($null -eq $raw) { Send-Json $ctx @{ error = @{ message = '请求体过大（上限 256KB）' } } 413; return }
        try { $cli = $raw | ConvertFrom-Json } catch { Send-Json $ctx @{ error = @{ message = '请求 JSON 解析失败' } } 400; return }

        $lines = @()
        foreach ($m in $cli.messages) {
          $who = if ($m.speaker -eq 'me') { '我' } else { '对方' }
          $prefix = ''
          if ($m.time) { $prefix = '[' + $m.time + '] ' }
          $lines += ($prefix + $who + '：' + $m.text)
        }
        $transcript = ($lines -join "`n")
        $statsJson = ($cli.metrics | ConvertTo-Json -Depth 8 -Compress)
        # 随机种子：保证每次分析即便场景相同，回复话术/CBT/行动清单也会按原文重新生成，不套模板
        $seed = (Get-Random).ToString() + '-' + (Get-Date).Ticks.ToString()

        $system = @'
你是"情绪显微镜"分析引擎，为用户提供基于聊天记录原文的关系模式分析。严格遵守：
1. 只能依据用户提供的聊天原文与本地统计数据，禁止编造原文中不存在的事件、引句与数据。
2. 不做心理或人格诊断，禁止输出"NPD、渣男、抑郁症人格、PUA人格"等标签；只用"倾向、信号、模式"描述行为。
3. 每个标签的 evidence 必须是聊天原文的逐字摘录（每条不超过40字），不得改写；找不到证据就用空数组。
4. replies 三档话术、cbt 各字段、actions 行动清单都必须紧扣本次聊天原文中的具体语句、具体冲突与具体场景写出，禁止输出与本次对话无关的通用模板；不同的聊天原文必须产出明显不同的措辞。
5. 禁止生成羞辱、报复、操控、曝光、跟踪、威胁类话术；回复话术只可用于健康边界表达。
6. 语气冷静、短句、事实优先，不煽情、不评判用户、不煽动仇恨、不用鸡汤空话。
7. 若样本少于5轮，在结论开头注明"样本不足，以下为倾向判断。"。
8. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字、不要使用代码块。
JSON 结构：
{
  "conclusion": "一句话结论，不超过60字，冷峻准确",
  "portraits": [ {"title":"≤12字的标签名","tone":"neg|neu|pos","evidence":["原文摘录"],"meaning":"≤80字，说明含义与边界"} ],
  "replies": {
    "gentle": {"variants":["三句不同的温和坚定话术"],"fit":"适用场景","reaction":"发送后可能反应","dont":"不要追加什么"},
    "cold":   {"variants":["三句短稳、不解释的话术"],"fit":"适用场景","reaction":"可能反应","dont":"不要追加什么"},
    "direct": {"variants":["三句明确需求底线后果的话术"],"fit":"适用场景","reaction":"可能反应","dont":"不要追加什么"}
  },
  "cbt": {"autoThought":"用户脑中反复出现的一句话","distortions":["认知歪曲名+一句解释"],"forEvidence":["支持自动思维的证据，基于原文"],"againstEvidence":["反对证据"],"alternative":"更平衡的替代性想法","worth":["3-5条自我价值证据"]},
  "actions": ["5项30分钟内可完成的具体行动"]
}
portraits 给 3-5 个，必须包含至少1个中性或正向视角（若关系健康则以正向为主，不硬找问题）。
'@
        $user = "场景：$($cli.scene)；关系：$($cli.relation)；用户目标：$($cli.goal)`n" +
                "补充背景：$($cli.bg)`n`n" +
                "本地统计（供参考，不要重复输出数字到结论里）：$statsJson`n不对等指数：$($cli.score)/100`n`n" +
                "本次分析种子（用于打破模板惯性，确保每次输出不同）：$seed`n`n" +
                "聊天记录：`n$transcript"

        $payload = @{
          model = $appCfg.TextModel
          temperature = 0.5
          top_p = 0.9
          max_tokens = 6144
          response_format = @{ type = 'json_object' }
          messages = @(
            @{ role = 'system'; content = $system },
            @{ role = 'user'; content = $user }
          )
        } | ConvertTo-Json -Depth 10 -Compress

        # 上游偶发慢响应（成功通常 15-35s，繁忙时近 50s 才失败）：单次超时放宽到 55s，
        # 429/5xx/504/1305 退避重试最多 3 次（6s、12s），最坏约 183s；前端超时 200s 可覆盖
        $up = $null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        for ($try = 1; $try -le 3; $try++) {
          $up = Invoke-AI '/chat/completions' $payload 55000
          if ($up.Status -eq 200) { break }
          $retryable = ($up.Status -eq 429 -or $up.Status -ge 500 -or $up.Body -match '"code"\s*:\s*"?1305')
          if (-not $retryable -or $try -eq 3) { break }
          Start-Sleep -Seconds (6 * $try)
        }
        $sw.Stop()
        $errKind = ''
        if ($up.Status -ne 200) { try { $ej2 = $up.Body | ConvertFrom-Json; if ($ej2.error -and $ej2.error.message) { $errKind = ($ej2.error.message -replace '\s+', ' ') } } catch {}; if ($errKind.Length -gt 100) { $errKind = $errKind.Substring(0, 100) } }
        Write-ApiLog ('analyze status={0} tries={1} model={2} ms={3} err={4}' -f $up.Status, $try, $appCfg.TextModel, $sw.ElapsedMilliseconds, $errKind)
        if ($up.Status -ne 200) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($up.Body)) 'application/json; charset=utf-8' $up.Status; return }
        $upObj = $up.Body | ConvertFrom-Json
        Send-Json $ctx @{ content = $upObj.choices[0].message.content; model = $upObj.model }
        return
      }
      if ($urlPath -eq '/api/ocr' -and $method -eq 'POST') {
        $raw = Read-Body $ctx 9437184
        if ($null -eq $raw) { Send-Json $ctx @{ error = @{ message = '图片过大（上限 9MB）' } } 413; return }
        try { $cli = $raw | ConvertFrom-Json } catch { Send-Json $ctx @{ error = @{ message = '请求 JSON 解析失败' } } 400; return }
        if (-not $cli.image -or $cli.image -notmatch '^data:image/') { Send-Json $ctx @{ error = @{ message = '缺少 image 字段（dataURL）' } } 400; return }

        $prompt = @'
这是一张手机聊天App截图。逐气泡识别并判定方位：
- 屏幕左侧气泡 side="left"，屏幕右侧气泡 side="right"
- 忽略时间戳、系统提示（如撤回提示、入群提示）、头像、昵称、状态栏
- 同一气泡内多行文字合并到一个 text，用换行或空格连接，保持原文用字、数字、标点，不要纠错或补全
只输出 JSON，不要任何解释或代码块：
{"messages":[{"side":"left","text":"内容"}]}
按从上到下顺序输出全部气泡。
'@
        $payload = @{
          model = $appCfg.VisionModel
          temperature = 0.05
          max_tokens = 3000
          messages = @(@{
            role = 'user'
            content = @(
              @{ type = 'image_url'; image_url = @{ url = $cli.image } },
              @{ type = 'text'; text = $prompt }
            )
          })
        } | ConvertTo-Json -Depth 10 -Compress

        $sw = [Diagnostics.Stopwatch]::StartNew()
        $up = Invoke-AI '/chat/completions' $payload 120000
        $sw.Stop()
        Write-ApiLog ('ocr status={0} model={1} ms={2}' -f $up.Status, $appCfg.VisionModel, $sw.ElapsedMilliseconds)
        if ($up.Status -ne 200) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($up.Body)) 'application/json; charset=utf-8' $up.Status; return }
        $upObj = $up.Body | ConvertFrom-Json
        Send-Json $ctx @{ content = $upObj.choices[0].message.content; model = $upObj.model }
        return
      }

      # ---------- 重新生成单条回复话术（每次调用都不同） ----------
      if ($urlPath -eq '/api/regen-reply' -and $method -eq 'POST') {
        $raw = Read-Body $ctx 262144
        if ($null -eq $raw) { Send-Json $ctx @{ error = @{ message = '请求体过大（上限 256KB）' } } 413; return }
        try { $cli = $raw | ConvertFrom-Json } catch { Send-Json $ctx @{ error = @{ message = '请求 JSON 解析失败' } } 400; return }

        $kind = $cli.kind
        $kindMap = @{
          gentle = '温和坚定的表达：先共情对方处境，再清楚说明自己的需求与边界，不指责'
          cold   = '短稳、不解释、不讨好的冷边界，3-15 字以内，不接对方情绪'
          direct = '明确说出需求、底线，以及若被忽视后会自然发生的后果'
        }
        if (-not $kind) { Send-Json $ctx @{ error = @{ message = '缺少 kind 字段（gentle/cold/direct）' } } 400; return }
        $style = $kindMap[$kind]
        if (-not $style) { Send-Json $ctx @{ error = @{ message = 'kind 必须为 gentle / cold / direct 之一' } } 400; return }

        $lines = @()
        foreach ($m in $cli.messages) {
          $who = if ($m.speaker -eq 'me') { '我' } else { '对方' }
          $prefix = if ($m.time) { '[' + $m.time + '] ' } else { '' }
          $lines += ($prefix + $who + '：' + $m.text)
        }
        $transcript = ($lines -join "`n")
        $statsJson = ($cli.metrics | ConvertTo-Json -Depth 8 -Compress)
        # 随机种子 + 时间戳：保证每次调用即便输入相同，输出也不同
        $seed = (Get-Random).ToString() + '-' + (Get-Date).Ticks.ToString()

        $system = @'
你是"情绪显微镜"的话术生成引擎，只输出一条全新的、与常见模板明显不同的回复话术。严格遵守：
1. 只可用于健康边界表达，不得用于伤害他人。
2. 语气冷静、短句、事实优先，不煽情、不评判用户、不鸡汤空话。
3. 避免使用以下被用滥的套路句式（及其近义变体）："我觉得"/"你是不是"/"我们能不能好好谈谈"/"我理解你的难处"/"我想我们需要"/"对不起，但是"。
4. 每次必须尝试新的切入角度、新的句式结构与新的措辞，避免与既往常见话术雷同。
5. 长度 8-60 字之间，单条，不要换行。
6. 只输出话术文本本身，不要任何解释、不要引号、不要代码块、不要 JSON 包裹。
'@
        $user = "场景：$($cli.scene)；关系：$($cli.relation)；用户目标：$($cli.goal)`n" +
                "补充背景：$($cli.bg)`n`n" +
                "本地统计（供参考，不要重复输出数字）：$statsJson`n不对等指数：$($cli.score)/100`n`n" +
                "本次话术风格要求：$style`n`n" +
                "本次生成种子（用于打破模板惯性，确保每次输出不同）：$seed`n`n" +
                "聊天记录：`n$transcript"

        $payload = @{
          model = $appCfg.TextModel
          temperature = 0.88
          top_p = 0.95
          max_tokens = 2048
          messages = @(
            @{ role = 'system'; content = $system },
            @{ role = 'user'; content = $user }
          )
        } | ConvertTo-Json -Depth 10 -Compress

        $up = $null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        for ($try = 1; $try -le 2; $try++) {
          $up = Invoke-AI '/chat/completions' $payload 45000
          if ($up.Status -eq 200) { break }
          $retryable = ($up.Status -eq 429 -or $up.Status -ge 500 -or $up.Body -match '"code"\s*:\s*"?1305')
          if (-not $retryable -or $try -eq 2) { break }
          Start-Sleep -Seconds 6
        }
        $sw.Stop()
        Write-ApiLog ('regen-reply kind={0} status={1} tries={2} model={3} ms={4}' -f $kind, $up.Status, $try, $appCfg.TextModel, $sw.ElapsedMilliseconds)
        if ($up.Status -ne 200) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($up.Body)) 'application/json; charset=utf-8' $up.Status; return }
        $upObj = $up.Body | ConvertFrom-Json
        $msg = $upObj.choices[0].message
        $content = $msg.content
        # 模型可能把输出放在 content，推理过程放在 reasoning_content（做兼容回退）
        if (-not $content -and $msg.reasoning_content) { $content = $msg.reasoning_content }
        Send-Json $ctx @{ content = $content; model = $upObj.model }
        return
      }

      # ---------- 重新生成 CBT 全量内容（每次调用都不同） ----------
      if ($urlPath -eq '/api/regen-cbt' -and $method -eq 'POST') {
        $raw = Read-Body $ctx 262144
        if ($null -eq $raw) { Send-Json $ctx @{ error = @{ message = '请求体过大（上限 256KB）' } } 413; return }
        try { $cli = $raw | ConvertFrom-Json } catch { Send-Json $ctx @{ error = @{ message = '请求 JSON 解析失败' } } 400; return }

        $lines = @()
        foreach ($m in $cli.messages) {
          $who = if ($m.speaker -eq 'me') { '我' } else { '对方' }
          $prefix = if ($m.time) { '[' + $m.time + '] ' } else { '' }
          $lines += ($prefix + $who + '：' + $m.text)
        }
        $transcript = ($lines -join "`n")
        $statsJson = ($cli.metrics | ConvertTo-Json -Depth 8 -Compress)
        $seed = (Get-Random).ToString() + '-' + (Get-Date).Ticks.ToString()

        $system = @'
你是"情绪显微镜"的 CBT（认知行为疗法）急救引擎，为用户重新生成一份与上一次明显不同的 CBT 自助分析。严格遵守：
1. 不做心理或人格诊断，禁止"NPD/PUA人格/抑郁症人格/渣男"等标签，只用"倾向、信号、模式"描述行为。
2. forEvidence 与 againstEvidence 必须基于聊天原文，不得编造引句；找不到证据就用空数组。
3. alternative 必须是更平衡、更保护用户自己的想法，不得是套话或鸡汤。
4. worth 必须是 3-5 条基于用户处境、但不依赖对方评价的自我价值证据，避免千篇一律。
5. 每次输出必须尝试新的角度与措辞，不得与常见 CBT 模板雷同。
6. 只输出一个 JSON 对象，不要输出 JSON 以外的任何文字、不要使用代码块。
JSON 结构：
{
  "autoThought": "用户脑中反复出现的一句话，≤30字",
  "distortions": ["2-4个认知歪曲名+一句解释"],
  "forEvidence": ["支持自动思维的证据，基于原文摘录"],
  "againstEvidence": ["反对证据或逻辑检验"],
  "alternative": "更平衡的替代性想法，≤80字",
  "worth": ["3-5条自我价值证据"]
}
'@
        $user = "场景：$($cli.scene)；关系：$($cli.relation)；用户目标：$($cli.goal)`n" +
                "补充背景：$($cli.bg)`n`n" +
                "本地统计（供参考，不要重复输出数字）：$statsJson`n不对等指数：$($cli.score)/100`n`n" +
                "本次生成种子（用于打破模板惯性，确保每次输出不同）：$seed`n`n" +
                "聊天记录：`n$transcript"

        $payload = @{
          model = $appCfg.TextModel
          temperature = 0.68
          top_p = 0.92
          max_tokens = 4096
          response_format = @{ type = 'json_object' }
          messages = @(
            @{ role = 'system'; content = $system },
            @{ role = 'user'; content = $user }
          )
        } | ConvertTo-Json -Depth 10 -Compress

        $up = $null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        for ($try = 1; $try -le 3; $try++) {
          $up = Invoke-AI '/chat/completions' $payload 60000
          if ($up.Status -eq 200) { break }
          $retryable = ($up.Status -eq 429 -or $up.Status -ge 500 -or $up.Body -match '"code"\s*:\s*"?1305')
          if (-not $retryable -or $try -eq 3) { break }
          Start-Sleep -Seconds (6 * $try)
        }
        $sw.Stop()
        Write-ApiLog ('regen-cbt status={0} tries={1} model={2} ms={3}' -f $up.Status, $try, $appCfg.TextModel, $sw.ElapsedMilliseconds)
        if ($up.Status -ne 200) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($up.Body)) 'application/json; charset=utf-8' $up.Status; return }
        $upObj = $up.Body | ConvertFrom-Json
        $msg = $upObj.choices[0].message
        $content = $msg.content
        if (-not $content -and $msg.reasoning_content) { $content = $msg.reasoning_content }
        Send-Json $ctx @{ content = $content; model = $upObj.model }
        return
      }

      # ---------- 重新生成今日不内耗行动清单（每次调用 AI，基于原文生成全新内容） ----------
      if ($urlPath -eq '/api/regen-actions' -and $method -eq 'POST') {
        $raw = Read-Body $ctx 262144
        if ($null -eq $raw) { Send-Json $ctx @{ error = @{ message = '请求体过大（上限 256KB）' } } 413; return }
        try { $cli = $raw | ConvertFrom-Json } catch { Send-Json $ctx @{ error = @{ message = '请求 JSON 解析失败' } } 400; return }

        $lines = @()
        foreach ($m in $cli.messages) {
          $who = if ($m.speaker -eq 'me') { '我' } else { '对方' }
          $prefix = if ($m.time) { '[' + $m.time + '] ' } else { '' }
          $lines += ($prefix + $who + '：' + $m.text)
        }
        $transcript = ($lines -join "`n")
        $statsJson = ($cli.metrics | ConvertTo-Json -Depth 8 -Compress)
        # 随机种子 + 时间戳 + 旧行动清单哈希：保证每次调用即便输入相同，输出也不同
        $seed = (Get-Random).ToString() + '-' + (Get-Date).Ticks.ToString()
        # 把上一次的行动清单传给模型，明确要求不要重复
        $prevArr = @($cli.previousActions | Where-Object { $_ })
        $prevActions = ''
        if ($prevArr.Count -gt 0) {
          $prevActions = '上次生成的行动清单（本次必须明显不同）：' + ($prevArr -join ' | ') + "`n`n"
        }

        $system = @'
你是"情绪显微镜"的行动清单生成引擎，为用户重新生成一份与上一次明显不同的"今日不内耗行动清单"。严格遵守：
1. 必须基于用户提供的聊天原文重新分析当前处境，不得使用通用模板。
2. 每项行动必须是 30 分钟内可完成、具体可执行、当下可立刻做的小动作（不依赖他人配合）。
3. 至少有 1 项与身体状态相关（散步 / 拉伸 / 喝水 / 屏幕朝下 / 冷水洗脸 等）。
4. 至少有 1 项与信息边界相关（关闭通知 / 备注改名 / 计时器 / 写下但不发送 等）。
5. 至少有 1 项与自我证据相关（写下需求 / 列两列控制与不可控 / 给安全朋友发消息 等）。
6. 不得重复上次生成清单中的任何一条；措辞、切入点、行为方式都要换新角度。
7. 不得煽情、不得说教、不得使用"加油、你值得、抱抱"这类鸡汤话。
8. 每条 8-40 字之间，5 条，按编号 1-5 输出。
9. 只输出一个 JSON 对象，不要任何解释、不要代码块：
{"actions":["1. xxx","2. xxx","3. xxx","4. xxx","5. xxx"]}
'@
        $user = "场景：$($cli.scene)；关系：$($cli.relation)；用户目标：$($cli.goal)`n" +
                "补充背景：$($cli.bg)`n`n" +
                "本地统计（供参考，不要重复输出数字）：$statsJson`n不对等指数：$($cli.score)/100`n`n" +
                "本次生成种子（用于打破模板惯性，确保每次输出不同）：$seed`n`n" +
                $prevActions +
                "聊天记录：`n$transcript"

        $payload = @{
          model = $appCfg.TextModel
          temperature = 0.85
          top_p = 0.95
          max_tokens = 2048
          response_format = @{ type = 'json_object' }
          messages = @(
            @{ role = 'system'; content = $system },
            @{ role = 'user'; content = $user }
          )
        } | ConvertTo-Json -Depth 10 -Compress

        $up = $null
        $sw = [Diagnostics.Stopwatch]::StartNew()
        for ($try = 1; $try -le 3; $try++) {
          $up = Invoke-AI '/chat/completions' $payload 40000
          if ($up.Status -eq 200) { break }
          $retryable = ($up.Status -eq 429 -or $up.Status -ge 500 -or $up.Body -match '"code"\s*:\s*"?1305')
          if (-not $retryable -or $try -eq 3) { break }
          Start-Sleep -Seconds (6 * $try)
        }
        $sw.Stop()
        Write-ApiLog ('regen-actions status={0} tries={1} model={2} ms={3}' -f $up.Status, $try, $appCfg.TextModel, $sw.ElapsedMilliseconds)
        if ($up.Status -ne 200) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($up.Body)) 'application/json; charset=utf-8' $up.Status; return }
        $upObj = $up.Body | ConvertFrom-Json
        $msg = $upObj.choices[0].message
        $content = $msg.content
        if (-not $content -and $msg.reasoning_content) { $content = $msg.reasoning_content }
        Send-Json $ctx @{ content = $content; model = $upObj.model }
        return
      }

      Send-Json $ctx @{ error = @{ message = '未知 API 路径' } } 404
      return
    }

    # ---------- 静态文件 ----------
    if ($urlPath -eq '/') { $urlPath = '/index.html' }
    $rel = $urlPath.TrimStart('/') -replace '/', '\'
    if ($rel.Contains('..')) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes('forbidden')) 'text/plain' 403; return }
    $file = Join-Path $root $rel
    if (-not (Test-Path $file -PathType Leaf)) { Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes('404 not found')) 'text/plain' 404; return }
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $mime = switch ($ext) {
      '.html' { 'text/html; charset=utf-8' }
      '.js'   { 'application/javascript; charset=utf-8' }
      '.css'  { 'text/css; charset=utf-8' }
      '.json' { 'application/json; charset=utf-8' }
      '.png'  { 'image/png' }
      '.jpg'  { 'image/jpeg' }
      '.jpeg' { 'image/jpeg' }
      '.gif'  { 'image/gif' }
      '.webp' { 'image/webp' }
      '.svg'  { 'image/svg+xml' }
      '.ico'  { 'image/x-icon' }
      '.gz'   { 'application/gzip' }
      default { 'application/octet-stream' }
    }
    $cache = if ($ext -in @('.html', '.js', '.css')) { 'no-cache' } elseif ($urlPath.StartsWith('/vendor/')) { 'public, max-age=86400' } else { 'no-cache' }
    Send-Bytes $ctx ([IO.File]::ReadAllBytes($file)) $mime 200 $cache
  } catch {
    try { Send-Json $ctx @{ error = @{ message = ('服务器内部错误：' + $_.Exception.Message) } } 500 } catch {}
  } finally {
    try { $ctx.Response.Close() } catch {}
  }
}

# ---------- 启动 ----------
$pool = [RunspaceFactory]::CreateRunspacePool(1, 8)
$pool.Open()

# 优先绑定所有网卡（+），让同一局域网的手机/平板可直接访问；
# 无权限（非管理员且未做 urlacl 预留）时自动回退到仅本机 localhost
$listener = New-Object Net.HttpListener
$boundAny = $false
try {
  $listener.Prefixes.Add("http://+:$($cfg.Port)/")
  $listener.Start()
  $boundAny = $true
} catch {
  try { $listener.Close() } catch {}
  $listener = New-Object Net.HttpListener
  $listener.Prefixes.Add("http://localhost:$($cfg.Port)/")
  $listener.Start()
}

$mask = if ($cfg.ApiKey) { $cfg.ApiKey.Substring(0, 4) + '****' + $cfg.ApiKey.Substring($cfg.ApiKey.Length - 4) } else { '(未配置)' }
Write-Host "============================================================"
Write-Host " 情绪显微镜服务已启动: http://localhost:$($cfg.Port)/"
if ($boundAny) {
  $lanIps = @()
  try {
    $lanIps = [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
      Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' } |
      ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
      Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } |
      ForEach-Object { $_.Address.IPAddressToString }
  } catch {}
  foreach ($ip in $lanIps) { Write-Host " 局域网设备访问: http://$ip`:$($cfg.Port)/  （手机/平板需与本机同一 Wi-Fi）" }
  if (-not $lanIps) { Write-Host " （未检测到局域网 IPv4 地址）" }
} else {
  Write-Host " 提示: 当前仅本机能访问；需手机访问时请以管理员身份运行本脚本（自动开放局域网）"
}
Write-Host " 文本模型: $($cfg.TextModel)   视觉模型: $($cfg.VisionModel)"
Write-Host " 密钥状态: $mask"
Write-Host " 按 Ctrl+C 停止"
Write-Host "============================================================"

# 主线程：轮询接收连接并投递到线程池；已完成的作业在此回收（不依赖委托回调）
$jobs = New-Object System.Collections.ArrayList
$acceptAr = $listener.BeginGetContext($null, $null)
try {
  while ($listener.IsListening) {
    # 回收已完成作业
    for ($i = $jobs.Count - 1; $i -ge 0; $i--) {
      $j = $jobs[$i]
      if ($j.Ar.IsCompleted) {
        try {
          $out = $j.Ps.EndInvoke($j.Ar)
          if ($j.Ps.HadErrors) {
            foreach ($e in $j.Ps.Streams.Error) {
              [IO.File]::AppendAllText((Join-Path $cfg.Root 'server-error.log'),
                ((Get-Date).ToString('s') + ' ' + $e.ToString() + "`n" + $e.InvocationInfo.PositionMessage + "`n---`n"),
                [Text.Encoding]::UTF8)
            }
          }
        } catch {
          [IO.File]::AppendAllText((Join-Path $cfg.Root 'server-error.log'),
            ((Get-Date).ToString('s') + ' EndInvoke: ' + $_.Exception.Message + "`n---`n"), [Text.Encoding]::UTF8)
        }
        try { $j.Ps.Dispose() } catch {}
        $jobs.RemoveAt($i)
      }
    }
    # 在唯一的挂起接收上等待 200ms；超时继续回收作业，不重复发起接收
    if (-not $acceptAr.AsyncWaitHandle.WaitOne(200)) { continue }
    $ctx = $null
    try { $ctx = $listener.EndGetContext($acceptAr) } catch { break }
    # 立即重新挂起接收，再处理当前连接
    $acceptAr = $listener.BeginGetContext($null, $null)

    $ps = [PowerShell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($handler.ToString()).AddArgument($ctx).AddArgument($cfg)
    try {
      $iar = $ps.BeginInvoke()
      [void]$jobs.Add([PSCustomObject]@{ Ps = $ps; Ar = $iar })
    } catch {
      try {
        $diag = '{"error":{"message":"dispatch failed: ' + ($_.Exception.Message -replace '"', "'") + '"}}'
        $busy = [Text.Encoding]::UTF8.GetBytes($diag)
        $ctx.Response.StatusCode = 503
        $ctx.Response.ContentType = 'application/json; charset=utf-8'
        $ctx.Response.OutputStream.Write($busy, 0, $busy.Length)
        $ctx.Response.Close()
      } catch {}
      $ps.Dispose()
    }
  }
} finally {
  try { $listener.Stop(); $listener.Close() } catch {}
  Start-Sleep -Milliseconds 500
  foreach ($j in $jobs) {
    try { $null = $j.Ps.EndInvoke($j.Ar) } catch {}
    try { $j.Ps.Dispose() } catch {}
  }
  $pool.Close(); $pool.Dispose()
}
