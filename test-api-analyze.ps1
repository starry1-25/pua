param(
  [int]$Port = 8165,
  [string]$Out = 'tests\out-analyze.json'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$payload = @{
  scene    = '伴侣沟通'
  relation = '恋爱半年'
  goal     = '想看清是否被精神控制'
  bg       = '近期频繁争吵'
  score    = 58
  metrics  = @{ myCount = 3; otherCount = 8; myShare = 34; shortRatio = 20; otherAvg = 12.5 }
  messages = @(
    @{ speaker = 'other'; text = '在吗' }
    @{ speaker = 'other'; text = '你到底什么意思' }
    @{ speaker = 'me';    text = '我不是说了吗今天加班' }
    @{ speaker = 'other'; text = '行 你忙吧' }
    @{ speaker = 'other'; text = '每次都这样 你根本不在乎我' }
    @{ speaker = 'me';    text = '对不起 我明天请你吃饭好不好' }
    @{ speaker = 'other'; text = '不用了 没胃口' }
    @{ speaker = 'other'; text = '你跟工作过吧' }
    @{ speaker = 'me';    text = '别这样 我真的很累' }
    @{ speaker = 'other'; text = '累的人是我吧 你考虑过我的感受吗' }
    @{ speaker = 'other'; text = '算了 说了也没用' }
  )
} | ConvertTo-Json -Depth 6 -Compress

$url = "http://localhost:$Port/api/analyze"
Write-Host "POST $url"
$resp = $null
for ($i = 1; $i -le 6; $i++) {
  try {
    $resp = Invoke-RestMethod -Uri $url -Method Post -ContentType 'application/json; charset=utf-8' `
      -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 120
    break
  } catch {
    $msg = "$($_.Exception.Message)"
    Write-Host "attempt $i failed: $msg"
    if ($i -eq 6) { throw }
    Start-Sleep -Seconds 20
  }
}

$outPath = Join-Path $root $Out
[IO.File]::WriteAllText($outPath, ($resp | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
Write-Host "model = $($resp.model)"
Write-Host "---- content ----"
Write-Host $resp.content
Write-Host "---- saved to $Out ----"

# 结构校验
try {
  $j = $resp.content.Trim() -replace '^```(?:json)?','' -replace '```$','' | ConvertFrom-Json
  Write-Host '---- schema check ----'
  Write-Host ("conclusion : {0}" -f [bool]$j.conclusion)
  Write-Host ("portraits  : {0} (tone/title/evidence/meaning)" -f @($j.portraits).Count)
  Write-Host ("replies    : gentle={0} cold={1} direct={2}" -f [bool]$j.replies.gentle.variants, [bool]$j.replies.cold.variants, [bool]$j.replies.direct.variants)
  Write-Host ("cbt        : {0} keys; worth={1}" -f (($j.cbt.PSObject.Properties.Name) -join ','), @($j.cbt.worth).Count)
  Write-Host ("actions    : {0}" -f @($j.actions).Count)
} catch {
  Write-Host "SCHEMA PARSE FAILED: $($_.Exception.Message)"
}
