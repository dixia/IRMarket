param(
    [string]$Skip = "ses_ff46824c8ffefXyw2z5y2qrvau",
    [string]$Model = "opencode/deepseek-v4-flash-free",
    [string]$OutFile = "$env:TEMP\opencode\session_summary_$(Get-Date -Format 'yyyyMMdd_HHmmss').txt"
)

# --- UTF-8 everywhere: fix mojibake when capturing `opencode run` output ---
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:PYTHONIOENCODING = 'utf-8'

$Prompt = @'
请只总结本会话历史，不要修改任何文件、不要执行任何操作，只输出文本：
1. 本次会话你学到了什么（项目/代码/流程/工具的事实或经验）？
2. 犯了哪些错误？经过哪些失败尝试才成功？简述关键尝试与迭代。
3. 有哪些值得写入 AGENTS.md 的内容（给未来 agent 的指引）？
请用中文简洁回答，400 字以内，涉及文件时标注路径。
'@

$list = (& opencode session list 2>&1 | Out-String)
$sessions = [System.Collections.Generic.List[object]]::new()
foreach ($line in ($list -split "`r?`n")) {
    if ($line -match '^\s*(ses_[A-Za-z0-9]+)\s') {
        $sessions.Add([pscustomobject]@{ Id = $matches[1]; Line = $line.Trim() })
    }
}

$skipSet = @{}
($Skip -split ',') | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $skipSet[$_.Trim()] = $true }

$targets = @($sessions | Where-Object { -not $skipSet.ContainsKey($_.Id) })

Write-Host "Found $($sessions.Count) sessions, will call $($targets.Count):"
foreach ($t in $targets) { Write-Host "  - $($t.Line)" }

if ($targets.Count -eq 0) { Write-Host "Nothing to do."; exit 0 }

$outDir = Split-Path $OutFile -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$all = [System.Text.StringBuilder]::new()
$seq = 0
foreach ($s in $targets) {
    $seq++
    $header = "==== [$seq/$($targets.Count)] Session: $($s.Line) ===="
    Write-Host "`n$header" -ForegroundColor Cyan
    $out = (& opencode run -s $s.Id -m $Model $Prompt 2>&1 | Out-String)
    $out = $out.TrimEnd()
    Write-Host $out
    [void]$all.AppendLine($header)
    [void]$all.AppendLine($out)
    [void]$all.AppendLine("")
}

[System.IO.File]::WriteAllText($OutFile, $all.ToString(), [System.Text.UTF8Encoding]::new($true))
Write-Host "`nCombined summary saved to: $OutFile" -ForegroundColor Green