param(
  [string]$BackendBase = "http://127.0.0.1:5000",
  [string]$ApiBase = "http://127.0.0.1:5000/api/v1",
  [string]$AimlBase = "http://127.0.0.1:8000",
  [bool]$StartAiml = $true,
  [string]$AimlWorkdir = (Join-Path $PSScriptRoot "..\aiml"),
  [int]$AimlWaitSeconds = 90
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host "==> $text" -ForegroundColor Cyan
}

function Assert-True([bool]$condition, [string]$message) {
  if (-not $condition) {
    throw "ASSERT FAILED: $message"
  }
}

function Wait-Url([string]$url, [int]$timeoutSec = 90) {
  $attempts = [Math]::Max(1, [Math]::Floor($timeoutSec / 3))
  for ($i = 0; $i -lt $attempts; $i++) {
    try {
      $resp = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url
      if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500) {
        return $true
      }
    } catch {}
    Start-Sleep -Seconds 3
  }
  return $false
}

function Invoke-Json([string]$method, [string]$url, [string]$body = $null, [hashtable]$headers = @{}, [int]$timeoutSec = 45) {
  $params = @{ UseBasicParsing = $true; Method = $method; Uri = $url; TimeoutSec = $timeoutSec }
  if ($headers -and $headers.Count -gt 0) { $params.Headers = $headers }
  if (($method -in @("POST","PUT","PATCH","DELETE")) -and ($null -ne $body) -and ($body -ne "")) {
    $params.ContentType = "application/json"
    $params.Body = $body
  }
  $resp = Invoke-WebRequest @params
  return ($resp.Content | ConvertFrom-Json)
}

function Stop-AimlProcesses {
  param([int]$ExcludePid = 0)
  $conn = netstat -ano | Select-String ":8000"
  if ($conn) {
    $pids = $conn | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
    foreach ($id in $pids) {
      if ([int]$id -ne $ExcludePid) { cmd /c "taskkill /PID $id /F >nul 2>nul" | Out-Null }
    }
  }
}

$aimlProc = $null
try {
  Write-Step "Health checks"
  $backendHealth = Invoke-Json "GET" "$BackendBase/health"
  Assert-True ($backendHealth.success -eq $true) "Backend health failed"
  Write-Host "Backend healthy"

  if ($StartAiml) {
    Write-Step "Starting AIML service"
    $aimlProc = Start-Process -FilePath python -ArgumentList "-m","uvicorn","main:app","--host","127.0.0.1","--port","8000" -WorkingDirectory $AimlWorkdir -PassThru
  }

  $aimlReady = Wait-Url "$AimlBase/health" $AimlWaitSeconds
  Assert-True $aimlReady "AIML did not become ready at $AimlBase/health"
  $aimlHealth = Invoke-Json "GET" "$AimlBase/health"
  Assert-True (($aimlHealth.status -eq "ok") -or ($aimlHealth.success -eq $true)) "AIML health response invalid"
  Write-Host "AIML healthy"

  Write-Step "Preparing test image"
  $imgPath = Join-Path $env:TEMP "swachhanet_smoke_test.png"
  $base64Png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8Bf1wAAAAASUVORK5CYII="
  [IO.File]::WriteAllBytes($imgPath, [Convert]::FromBase64String($base64Png))
  Assert-True (Test-Path $imgPath) "Failed to create test image"

  Write-Step "Flow 1: Upload image -> prediction"
  $wasteRaw = curl.exe -s --max-time 120 -X POST "$ApiBase/ai/predict-waste" -F "image=@$imgPath"
  $waste = $wasteRaw | ConvertFrom-Json
  Assert-True ($waste.success -eq $true) "predict-waste failed: $wasteRaw"
  Assert-True ($null -ne $waste.data.class) "predict-waste missing class"
  Assert-True ($null -ne $waste.data.confidence) "predict-waste missing confidence"
  Write-Host "predict-waste passed"

  Write-Step "Flow 3: Hotspot detection"
  $hotspotBody = @{
    coordinates = @(
      @{ lat = 12.9716; long = 77.5946 },
      @{ lat = 12.9718; long = 77.5948 },
      @{ lat = 12.9720; long = 77.5950 },
      @{ lat = 28.7041; long = 77.1025 }
    )
  } | ConvertTo-Json -Depth 4
  $hotspot = Invoke-Json "POST" "$ApiBase/ai/detect-hotspot" $hotspotBody
  Assert-True ($hotspot.success -eq $true) "detect-hotspot failed"
  Assert-True ($null -ne $hotspot.data.total_clusters) "detect-hotspot missing total_clusters"
  Write-Host "detect-hotspot passed"

  Write-Step "Flow 4: Trend prediction"
  $trendBody = @{
    historical_data = @(
      @{ date = "2026-03-20"; value = 120.0 },
      @{ date = "2026-03-21"; value = 132.0 },
      @{ date = "2026-03-22"; value = 128.0 },
      @{ date = "2026-03-23"; value = 135.0 },
      @{ date = "2026-03-24"; value = 140.0 },
      @{ date = "2026-03-25"; value = 138.0 },
      @{ date = "2026-03-26"; value = 145.0 }
    )
    forecast_days = 2
  } | ConvertTo-Json -Depth 4
  $trend = Invoke-Json "POST" "$ApiBase/ai/predict-trend" $trendBody
  Assert-True ($trend.success -eq $true) "predict-trend failed"
  Assert-True (($trend.data.forecast | Measure-Object).Count -ge 1) "predict-trend returned empty forecast"
  Write-Host "predict-trend passed"

  Write-Step "Flow 2: Submit complaint -> stored"
  $phone = "+919955$([int](Get-Random -Minimum 100000 -Maximum 999999))"
  $registerBody = @{ name = "Smoke User"; phone = $phone; password = "pass1234" } | ConvertTo-Json
  $register = Invoke-Json "POST" "$ApiBase/auth/register" $registerBody
  Assert-True ($register.success -eq $true) "register failed"

  $otpScript = @"
const path = require('path');
const fs = require('fs');
const cwd = process.cwd();
const repoRoot = fs.existsSync(path.join(cwd, 'backend', 'src', 'models', 'User.js')) ? cwd : path.join(cwd, '..');
const mongoose = require(path.join(repoRoot, 'backend', 'node_modules', 'mongoose'));
const User = require(path.join(repoRoot, 'backend', 'src', 'models', 'User'));
(async () => {
  await mongoose.connect('mongodb://localhost:27017/swachhanet');
  const u = await User.findOne({ phone: process.argv[1] }).select('otpSecret').lean();
  process.stdout.write(u?.otpSecret || '');
  await mongoose.disconnect();
  process.exit(0);
})();
"@
  $otp = node -e $otpScript $phone
  $otp = $otp.Trim()
  Assert-True ($otp.Length -ge 4) "Could not fetch OTP from DB"

  $verifyBody = @{ phone = $phone; otp = $otp } | ConvertTo-Json
  $verify = Invoke-Json "POST" "$ApiBase/auth/otp/verify" $verifyBody
  Assert-True ($verify.success -eq $true) "OTP verify failed"
  $token = $verify.data.accessToken
  Assert-True ($token.Length -gt 20) "Missing access token"

  $complaintRaw = curl.exe -s --max-time 60 -X POST "$ApiBase/complaints" -H "Authorization: Bearer $token" -F "issue_type=overflowing_bin" -F "lat=12.9716" -F "lng=77.5946" -F "description=smoke-test"
  $complaint = $complaintRaw | ConvertFrom-Json
  Assert-True ($complaint.success -eq $true) "Complaint submit failed: $complaintRaw"

  $listRaw = curl.exe -s --max-time 60 -X GET "$ApiBase/complaints" -H "Authorization: Bearer $token"
  $list = $listRaw | ConvertFrom-Json
  Assert-True ($list.success -eq $true) "Complaint list failed: $listRaw"
  Assert-True ((($list.data.data | Measure-Object).Count) -ge 1) "Complaint not found in list"
  Write-Host "complaint flow passed"

  if (Test-Path $imgPath) {
    Remove-Item $imgPath -Force
  }

  Write-Step "Smoke test PASSED"
  Write-Host "All critical flows succeeded."
  exit 0
}
catch {
  Write-Host ""
  Write-Host "Smoke test FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
finally {
  if ($aimlProc) {
    try { cmd /c "taskkill /PID $($aimlProc.Id) /F >nul 2>nul" | Out-Null } catch {}
    Stop-AimlProcesses -ExcludePid $aimlProc.Id
  }
}




