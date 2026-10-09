# Discord Rich Presence bridge for the discord-presence mod.
#
# Every Claude Code session writes a report of itself to <dir>/<session>.json:
#   { "phase": "idle|thinking|working", "since": <ms>, "activity": {...} }
# Every session also starts this bridge, but only one holds the leader mutex
# and talks to Discord; the others wait to take over when it goes. The leader
# shows the working sessions in turn, ten seconds each, or when none works,
# the one that finished last.
#
# A bridge exits when its own session's report is gone or stale.
param(
  [Parameter(Mandatory)][string]$ClientId,
  [Parameter(Mandatory)][string]$StateFile
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Threading.Thread]::CurrentThread.CurrentUICulture = 'en-US'
$StaleSeconds = 45       # sessions touch their report every 15 s
$TurnSeconds = 10        # how long each working session is shown
$MinSendSeconds = 4      # Discord allows 5 activity updates per 20 s
$KeepAliveSeconds = 15   # resend so a restarted Discord is noticed
$ReplyTimeoutMs = 5000
$RetrySeconds = 15
$KeepDays = 7            # older reports and logs are removed

$Dir = Split-Path -Parent $StateFile

function Say([string]$text) { [Console]::Out.WriteLine($text); [Console]::Out.Flush() }

# --- Discord IPC -------------------------------------------------------------

# A Discord that is still starting can accept the pipe and never answer.
function Read-Exact($pipe, [byte[]]$buf, [int]$n) {
  $o = 0
  while ($o -lt $n) {
    $read = $pipe.ReadAsync($buf, $o, $n - $o)
    if (-not $read.Wait($ReplyTimeoutMs)) { throw 'Discord did not answer' }
    if ($read.Result -le 0) { throw 'Discord closed the pipe' }
    $o += $read.Result
  }
}

function Send-Frame($pipe, [int]$op, [string]$json) {
  $body = [Text.Encoding]::UTF8.GetBytes($json)
  $head = [byte[]]::new(8)
  [BitConverter]::GetBytes($op).CopyTo($head, 0)
  [BitConverter]::GetBytes($body.Length).CopyTo($head, 4)
  $pipe.Write($head, 0, 8)
  $pipe.Write($body, 0, $body.Length)
  $pipe.Flush()
}

# Reads frames until a reply (op 1) arrives; answers pings, throws on close.
function Read-Reply($pipe) {
  while ($true) {
    $head = [byte[]]::new(8)
    Read-Exact $pipe $head 8
    $op = [BitConverter]::ToInt32($head, 0)
    $body = [byte[]]::new([BitConverter]::ToInt32($head, 4))
    Read-Exact $pipe $body $body.Length
    $json = [Text.Encoding]::UTF8.GetString($body)
    switch ($op) {
      1 { return $json }
      2 { throw "Discord closed the connection: $json" }
      3 { Send-Frame $pipe 4 $json }
    }
  }
}

function Connect-Discord {
  for ($i = 0; $i -lt 10; $i++) {
    if (-not [IO.File]::Exists("\\.\pipe\discord-ipc-$i")) { continue }
    $pipe = [IO.Pipes.NamedPipeClientStream]::new('.', "discord-ipc-$i", [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    try {
      $pipe.Connect(1000)
      Send-Frame $pipe 0 ('{"v":1,"client_id":"' + $ClientId + '"}')
      $ready = Read-Reply $pipe | ConvertFrom-Json
      Say "connected to Discord as $($ready.data.user.username)"
      $user = @{ id = [string]$ready.data.user.id; username = [string]$ready.data.user.username } | ConvertTo-Json -Compress
      Set-Content -LiteralPath (Join-Path $Dir 'user.json') -Value $user -Encoding UTF8
      return $pipe
    } catch {
      $pipe.Dispose()
      throw $_.Exception.GetBaseException().Message
    }
  }
  throw 'Discord is not running'
}

function Set-Activity($pipe, [string]$activityJson) {
  $nonce = [guid]::NewGuid().ToString()
  Send-Frame $pipe 1 ('{"cmd":"SET_ACTIVITY","args":{"pid":' + $PID + ',"activity":' + $activityJson + '},"nonce":"' + $nonce + '"}')
  $reply = Read-Reply $pipe | ConvertFrom-Json
  if ($reply.evt -eq 'ERROR') { Say "Discord refused the activity: $($reply.data.message)" }
}

# --- Choosing a session --------------------------------------------------------

function Read-Reports([datetime]$now) {
  foreach ($file in Get-ChildItem -LiteralPath $Dir -Filter '*.json' -File) {
    if ($file.Name -like '*.memo.json' -or $file.Name -in 'user.json', 'dm.json') { continue }
    if (($now - $file.LastWriteTimeUtc).TotalSeconds -gt $StaleSeconds) { continue }
    try { $r = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    if ($r.ended -or -not $r.activity) { continue }
    [pscustomobject]@{ Name = $file.Name; Phase = [string]$r.phase; Since = [double]$r.since; Activity = $r.activity }
  }
}

# The working sessions in turn, else the one that went idle last.
function Select-Report($reports, [datetime]$now) {
  $working = @($reports | Where-Object { $_.Phase -ne 'idle' } | Sort-Object Name)
  if ($working.Count) {
    $turn = [math]::Floor(([DateTimeOffset]$now).ToUnixTimeSeconds() / $TurnSeconds)
    return $working[$turn % $working.Count]
  }
  return $reports | Sort-Object Since -Descending | Select-Object -First 1
}

function Remove-OldFiles {
  $cutoff = [datetime]::UtcNow.AddDays(-$KeepDays)
  Get-ChildItem -LiteralPath $Dir -File | Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
    ForEach-Object { try { Remove-Item -LiteralPath $_.FullName } catch { } }
}

# --- Main loop -------------------------------------------------------------------

$mutex = [Threading.Mutex]::new($false, 'Local\claude-discord-presence')
$isLeader = $false
$pipe = $null
$sent = $null
$lastSend = [datetime]::MinValue
$nextConnect = [datetime]::MinValue
$lastWhy = $null

try {
  while ($true) {
    if (-not (Test-Path -LiteralPath $StateFile)) { break }
    $now = [datetime]::UtcNow
    if (($now - (Get-Item -LiteralPath $StateFile).LastWriteTimeUtc).TotalSeconds -gt $StaleSeconds * 4) { break }

    if (-not $isLeader) {
      try { $isLeader = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $isLeader = $true }
      if (-not $isLeader) { Start-Sleep -Seconds 1; continue }
      Say 'leading: this session talks to Discord'
      Remove-OldFiles
    }

    $chosen = Select-Report @(Read-Reports $now) $now
    $wanted = if ($chosen) { $chosen.Activity | ConvertTo-Json -Compress -Depth 10 } else { 'null' }

    $sinceSend = ($now - $lastSend).TotalSeconds
    if ($sinceSend -ge $MinSendSeconds -and ($wanted -ne $sent -or ($sinceSend -ge $KeepAliveSeconds -and $wanted -ne 'null'))) {
      if (-not $pipe -and $now -ge $nextConnect) {
        try { $pipe = Connect-Discord; $lastWhy = $null } catch {
          $why = "waiting for Discord: $($_.Exception.Message)"
          if ($why -ne $lastWhy) { Say $why; $lastWhy = $why }
          $nextConnect = $now.AddSeconds($RetrySeconds)
        }
      }
      if ($pipe) {
        try {
          Set-Activity $pipe $wanted
          $sent = $wanted
          $lastSend = $now
        } catch {
          Say "lost Discord: $($_.Exception.Message)"
          $pipe.Dispose(); $pipe = $null; $sent = $null
          $nextConnect = $now.AddSeconds(5)
        }
      }
    }
    Start-Sleep -Milliseconds 500
  }
} finally {
  if ($pipe) {
    try { Set-Activity $pipe 'null' } catch { }
    $pipe.Dispose()
  }
  if ($isLeader) { try { $mutex.ReleaseMutex() } catch { } }
  $mutex.Dispose()
}
