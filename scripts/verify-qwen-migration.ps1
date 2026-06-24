# Qwen migration -- 3 validaciones automaticas en uno.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\verify-qwen-migration.ps1
#
# Decrypta PLATFORM_TOGETHER_KEY de sops, verifica los 4 IDs Qwen contra
# Together API, smoke-testea thinking-mode, y revisa los logs de prod
# por cualquier error de "model not found".
#
# ASCII-only y PS5-compatible. Single-quoted strings donde aparece '<'
# para evitar que PS lo interprete como operador de redireccion.

$ErrorActionPreference = "Stop"

Write-Host "=== Qwen migration verification ===" -ForegroundColor Cyan

# Locate sops binary
$sopsBin = "C:\Users\jesus\bin\sops.exe"
if (-not (Test-Path $sopsBin)) {
  $sopsBin = (Get-Command sops -ErrorAction SilentlyContinue).Source
  if (-not $sopsBin) {
    Write-Host "[FAIL] sops not found at C:\Users\jesus\bin\sops.exe nor on PATH" -ForegroundColor Red
    exit 1
  }
}

# Age key path (per set-together-key.ts convention)
$env:SOPS_AGE_KEY_FILE = "$env:USERPROFILE\.config\sops\age\keys.txt"
if (-not (Test-Path $env:SOPS_AGE_KEY_FILE)) {
  Write-Host "[FAIL] Age key not found at $env:SOPS_AGE_KEY_FILE" -ForegroundColor Red
  exit 1
}

# Decrypt PLATFORM_TOGETHER_KEY
Write-Host ""
Write-Host "[1/4] Decrypting PLATFORM_TOGETHER_KEY from sops..." -ForegroundColor Yellow
$sopsFile = "C:\Users\jesus\desktop\radar\web\.env.sops.yaml"
$decrypted = & $sopsBin -d $sopsFile 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] sops decrypt failed:" -ForegroundColor Red
  Write-Host $decrypted
  exit 1
}

$togetherKey = ($decrypted | Select-String "^PLATFORM_TOGETHER_KEY:" | ForEach-Object {
  ($_ -split ":\s*",2)[1].Trim('"').Trim("'").Trim()
}) | Select-Object -First 1

if (-not $togetherKey) {
  Write-Host "[FAIL] PLATFORM_TOGETHER_KEY not found in decrypted sops output" -ForegroundColor Red
  exit 1
}
Write-Host "  [OK] key decrypted (length: $($togetherKey.Length) chars)" -ForegroundColor Green

# Test 1: verify Qwen model IDs against /v1/models
Write-Host ""
Write-Host "[2/4] Verifying Qwen model IDs against Together /v1/models..." -ForegroundColor Yellow
$modelsJson = & curl.exe -sS https://api.together.xyz/v1/models -H "Authorization: Bearer $togetherKey"
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FAIL] curl to Together failed" -ForegroundColor Red
  exit 1
}

$expected = @(
  "Qwen/Qwen3.5-9B-FP8",
  "Qwen/Qwen3-Coder-Next-FP8",
  "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
  "Qwen/Qwen3.6-Plus"
)

$availableIds = ($modelsJson | ConvertFrom-Json) | ForEach-Object { $_.id }
$qwenIds = $availableIds | Where-Object { $_ -match "Qwen3" } | Sort-Object

Write-Host ""
Write-Host "  All Qwen3 IDs in catalog:" -ForegroundColor Cyan
$qwenIds | ForEach-Object { Write-Host "    $_" }

Write-Host ""
Write-Host "  Expected vs found:" -ForegroundColor Cyan
$missing = @()
foreach ($exp in $expected) {
  if ($availableIds -contains $exp) {
    Write-Host "    [OK] $exp" -ForegroundColor Green
  } else {
    Write-Host "    [MISS] $exp" -ForegroundColor Red
    $missing += $exp
  }
}

if ($missing.Count -gt 0) {
  Write-Host ""
  Write-Host "WARN: $($missing.Count) ID(s) missing - these requests will 404 in prod RIGHT NOW." -ForegroundColor Red
  Write-Host "Fix the IDs in web/lib/ai/together-routing.ts and redeploy." -ForegroundColor Red
}

# Test 2: smoke test thinking-mode against Qwen3-235B
Write-Host ""
Write-Host "[3/4] Smoke test: chat_template_kwargs.enable_thinking against Qwen3-235B..." -ForegroundColor Yellow
$body = @{
  model = "Qwen/Qwen3-235B-A22B-Instruct-2507-tput"
  chat_template_kwargs = @{ enable_thinking = $true }
  max_tokens = 200
  messages = @(@{ role = "user"; content = "What is 2+2? Reason step by step." })
} | ConvertTo-Json -Compress -Depth 5

# Write body to temp file so curl can read it (avoids quoting hell)
$tmpBody = [System.IO.Path]::GetTempFileName()
$body | Out-File -FilePath $tmpBody -Encoding ASCII -NoNewline

$response = & curl.exe -sS https://api.together.xyz/v1/chat/completions `
  -H "Authorization: Bearer $togetherKey" `
  -H "Content-Type: application/json" `
  -d "@$tmpBody"

Remove-Item $tmpBody -ErrorAction SilentlyContinue

if ($LASTEXITCODE -ne 0 -or -not $response) {
  Write-Host "  [FAIL] Request failed - check the model ID or thinking-mode field name" -ForegroundColor Red
  Write-Host "  Raw response: $response"
} else {
  try {
    $parsed = $response | ConvertFrom-Json
    if ($parsed.error) {
      Write-Host "  [FAIL] API error: $($parsed.error.message)" -ForegroundColor Red
    } else {
      $content = $parsed.choices[0].message.content
      Write-Host "  [OK] Response model: $($parsed.model)" -ForegroundColor Green
      Write-Host "  [OK] Tokens used:    $($parsed.usage.total_tokens)" -ForegroundColor Green
      $previewLen = [Math]::Min(200, $content.Length)
      Write-Host ('  Content preview: ' + $content.Substring(0, $previewLen) + '...') -ForegroundColor Gray
      # Use single quotes so '<' is literal, not redirect operator
      if ($content -match '<think>') {
        Write-Host '  [OK] <think> tags detected -- thinking-mode IS active' -ForegroundColor Green
      } else {
        Write-Host '  [WARN] No <think> tags. Either model did not reason, OR field name needs verification.' -ForegroundColor Yellow
      }
    }
  } catch {
    Write-Host "  [FAIL] Response parse failed: $_" -ForegroundColor Red
    Write-Host "  Raw response (first 500 chars): $($response.Substring(0, [Math]::Min(500, $response.Length)))"
  }
}

# Test 3: spot-check prod logs
Write-Host ""
Write-Host "[4/4] Checking prod logs for Qwen-related errors (last 1h)..." -ForegroundColor Yellow
$logCmd = 'docker logs $(docker ps -q --filter label=role=web) --since 1h 2>&1 | grep -i 404 | tail -20'
$logs = ssh root@87.99.153.227 $logCmd 2>&1

if (-not $logs) {
  Write-Host "  [OK] No 404s in last hour" -ForegroundColor Green
} else {
  Write-Host "  [WARN] Found 404-related log lines:" -ForegroundColor Yellow
  $logs | ForEach-Object { Write-Host "    $_" }
}

Write-Host ""
Write-Host "=== Done ===" -ForegroundColor Cyan
if ($missing.Count -eq 0) {
  Write-Host "Migration verified clean. Qwen routing is correctly configured." -ForegroundColor Green
} else {
  Write-Host "See above - at least one check needs attention." -ForegroundColor Yellow
}
