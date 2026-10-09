import type { EngineInterface, Register } from 'claude-code'

// The hooks module cannot open Discord's IPC pipe itself, so it writes the
// wanted activity as JSON to a state file, and discord-rpc.ps1, spawned for
// the session's life, mirrors that file into Discord.

const HEARTBEAT_MS = 15_000
const LIMIT_WARN_PERCENT = 80
const IDLE = 'Waiting for a prompt'
const AWAY = '💤 Away'
const THINKING = 'Thinking…'

type Phase = 'idle' | 'thinking' | 'working'

// Discord's activity types, as the card titles them.
const PLAYING = 0 // "Playing ClaudeCode": a timer
// status_display_type: which text the member list shows beside the name.
const SHOW_DETAILS = 2

type Activity = {
  type: number
  status_display_type: number
  details: string
  state?: string
  timestamps: { start: number } | { end: number }
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string }
}

type ToolArgs = { tool: string; file_path?: unknown; notebook_path?: unknown }

// What survives a reload of the module, kept beside the state file.
type Memo = { chatTitle?: string; files: string[]; commands: number }

type Presence = {
  clientId: string
  largeImage: string
  showProject: boolean
  showFile: boolean
  showCost: boolean
  showStats: boolean
  stateIcons: boolean
  afkMs: number
  webhookUrl: string
  tagInChannel: boolean
  notifyAfterMs: number
  statePath?: string
  botTokenPath?: string
  dmChannel?: Promise<string | undefined>
  startedAt: number
  project: string
  model: string
  details: string
  phase: Phase
  memo: Memo
  costUsd?: number
  contextPercent?: number
  prompts?: number
  limit?: { percent: number; resetsAt?: number }
  agents: number
  phaseSince: number
  ended?: boolean
  background?: boolean
  starting?: Promise<void>
  log: string[]
}

export const newPresence = (options: Record<string, unknown>): Presence => ({
  clientId: String(options.clientId ?? '').trim(),
  largeImage: String(options.largeImage ?? '').trim(),
  showProject: options.showProject !== false,
  showFile: options.showFile !== false,
  showCost: options.showCost !== false,
  showStats: options.showStats !== false,
  stateIcons: options.stateIcons === true,
  afkMs: Math.max(0, Number(options.afkMinutes ?? 15)) * 60_000,
  webhookUrl: String(options.webhookUrl ?? '').trim(),
  tagInChannel: options.tagInChannel === true,
  notifyAfterMs: Math.max(0, Number(options.notifyAfterSeconds ?? 60)) * 1000,
  startedAt: Date.now(),
  project: '',
  model: '',
  details: IDLE,
  phase: 'idle',
  memo: { files: [], commands: 0 },
  agents: 0,
  phaseSince: Date.now(),
  log: [],
})

export const basename = (path: string) =>
  path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path

// claude-opus-5-5[1m] -> Opus 5.5
export const prettyModel = (id: string) => {
  const [family, ...version] = id.replace(/\[.*\]$/, '').replace(/^claude-/, '').split('-')
  if (!family) return id
  const name = family[0].toUpperCase() + family.slice(1)
  return version.length ? `${name} ${version.join('.')}` : name
}

const EDITS = ['Edit', 'Write', 'NotebookEdit']
const COMMANDS = ['Bash', 'PowerShell']

export const describeTool = (args: ToolArgs, showFile: boolean) => {
  const path = String(args.file_path ?? args.notebook_path ?? '')
  const file = showFile && path ? ` ${basename(path)}` : ''
  if (EDITS.includes(args.tool)) return file ? `Editing${file}` : 'Editing code'
  if (COMMANDS.includes(args.tool)) return 'Running a command'
  switch (args.tool) {
    case 'Read':
      return file ? `Reading${file}` : 'Reading code'
    case 'Grep':
    case 'Glob':
      return 'Searching the code'
    case 'WebFetch':
    case 'WebSearch':
      return 'Browsing the web'
    case 'Agent':
      return 'Delegating to a subagent'
    default:
      return args.tool.startsWith('mcp__')
        ? `Using ${args.tool.split('__')[1]}`
        : `Using ${args.tool}`
  }
}

// Counts a finished edit or command into the session's tallies.
export const countTool = (memo: Memo, args: ToolArgs): Memo => {
  if (EDITS.includes(args.tool)) {
    const path = String(args.file_path ?? args.notebook_path ?? '')
    return path && !memo.files.includes(path) ? { ...memo, files: [...memo.files, path] } : memo
  }
  return COMMANDS.includes(args.tool) ? { ...memo, commands: memo.commands + 1 } : memo
}

// Discord takes 2..128 characters per line.
const fit = (text: string) => (text.length > 128 ? `${text.slice(0, 127)}…` : text.padEnd(2))

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// $8.57, $85.7, $123, $1.2k: at most five characters.
export const formatCost = (usd: number) => {
  if (usd < 9.995) return `$${usd.toFixed(2)}`
  if (usd < 99.95) return `$${usd.toFixed(1)}`
  if (usd < 999.5) return `$${Math.round(usd)}`
  return `$${(usd / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

// --- Fitting a line into the profile card ---------------------------------
// The card shows about 30 average letters of a line before it cuts it off.
// Widths are in average letters of Discord's proportional font: emoji draw
// about two wide, the bar's cells a little wider than a letter, spaces and
// punctuation about half.
export const LINE_WIDTH = 24
const MIN_NAME_WIDTH = 6

const charWidth = (ch: string) => {
  if (/\p{Extended_Pictographic}/u.test(ch)) return 2
  if (/[⺀-鿿가-힯豈-﫿＀-｠]/.test(ch)) return 2
  if (ch === '▰' || ch === '▱') return 1.2
  if (/[\s.,:;·'|!ijlrtf()\[\]]/.test(ch)) return 0.5
  if (/[MWmwМШЩЖЮФЫ@%]/.test(ch)) return 1.3
  return 1
}

const chars = (text: string) => [...text.replace(/️/g, '')]

export const textWidth = (text: string) => chars(text).reduce((w, ch) => w + charWidth(ch), 0)

// Cuts text to `max` wide, ending it with "…" when cut.
export const truncate = (text: string, max: number) => {
  if (textWidth(text) <= max) return text
  let out = ''
  for (const ch of chars(text)) {
    if (textWidth(out + ch) + 1 > max) break
    out += ch
  }
  return `${out.trimEnd()}…`
}

// Cuts a file name in the middle so its extension stays: very-long-na….tsx
export const truncateFile = (name: string, max: number) => {
  if (textWidth(name) <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  return truncate(name.slice(0, name.length - ext.length), max - textWidth(ext)) + ext
}

// The first line: the action, then running agents as "🤖 3".
export const detailsLine = (details: string, agents: number) => {
  const suffix = agents > 0 ? ` · 🤖 ${agents}` : ''
  const room = LINE_WIDTH - textWidth(suffix)
  const file = /^(Editing|Reading) (.+)$/.exec(details)
  const text = file
    ? `${file[1]} ${truncateFile(file[2], room - textWidth(file[1]) - 0.5)}`
    : truncate(details, room)
  return text + suffix
}

// The second line: "📁 name · $8.57 · ▰▰▱▱▱". The name gives way first; when
// even a short name would not fit, the bar goes, then the cost.
export const stateLine = (place: string, cost: string, bar: string) => {
  const space = place.indexOf(' ')
  const icon = space > 0 ? place.slice(0, space + 1) : ''
  const name = (space > 0 ? place.slice(space + 1) : place).replace(/\s+/g, ' ').trim()
  const tails = [[cost, bar], [cost], []].map(t => t.filter(Boolean))
  for (const tail of tails) {
    const rest = tail.map(t => ` · ${t}`).join('')
    if (!name) {
      const line = tail.join(' · ')
      if (textWidth(line) <= LINE_WIDTH) return line
      continue
    }
    const room = LINE_WIDTH - textWidth(icon) - textWidth(rest)
    if (room >= Math.min(MIN_NAME_WIDTH, textWidth(name))) return icon + truncate(name, room) + rest
  }
  return icon + truncate(name, LINE_WIDTH - textWidth(icon))
}

const PHASE_LABEL: Record<Phase, string> = { idle: 'Waiting', thinking: 'Thinking', working: 'Working' }

// The context window's fill as a bar of 5 cells, short enough for the
// profile card's line (about 30 characters): ▰▰▱▱▱
export const contextBar = (percent: number) => {
  const full = Math.round(Math.min(100, Math.max(0, percent)) / 20)
  return `${'▰'.repeat(full)}${'▱'.repeat(5 - full)}`
}

export const isAway = (p: Presence, now: number) =>
  p.phase === 'idle' && p.afkMs > 0 && now - p.phaseSince >= p.afkMs

export const toActivity = (p: Presence, now = Date.now()): Activity => {
  const away = isAway(p, now)
  const activity: Activity = {
    type: PLAYING,
    status_display_type: SHOW_DETAILS,
    details: fit(detailsLine(away ? AWAY : p.details, p.agents)),
    timestamps: { start: away ? p.phaseSince : p.startedAt },
  }

  const cost = p.showCost && p.costUsd !== undefined ? formatCost(p.costUsd) : ''
  const bar = p.showStats && p.contextPercent !== undefined ? contextBar(p.contextPercent) : ''
  const state = stateLine(p.showProject ? p.project : '', cost, bar)
  if (state) activity.state = fit(state)

  // Waiting near the 5-hour limit: count down to its reset.
  const resetsAt = p.showStats && p.limit?.resetsAt && p.limit.resetsAt > now ? p.limit.resetsAt : undefined
  if (p.phase === 'idle' && !away && resetsAt && p.limit!.percent >= LIMIT_WARN_PERCENT) {
    activity.timestamps = { end: resetsAt }
  }

  const stats = !p.showStats ? [] : [
    p.contextPercent !== undefined ? `context ${Math.round(p.contextPercent)}%` : '',
    p.prompts !== undefined ? plural(p.prompts, 'prompt', 'prompts') : '',
    p.memo.files.length ? `${plural(p.memo.files.length, 'file', 'files')} edited` : '',
    p.memo.commands ? plural(p.memo.commands, 'command', 'commands') : '',
    p.limit ? `5h limit ${Math.round(p.limit.percent)}%` : '',
  ].filter(Boolean)
  // The stats go on the small state icon's hover; without the icon, on the large one's.
  const assets: NonNullable<Activity['assets']> = {}
  if (p.largeImage) {
    assets.large_image = p.largeImage
    const extra = p.stateIcons ? [] : stats
    assets.large_text = fit([`Claude Code · ${p.model}`, ...extra].join(' · '))
  }
  if (p.stateIcons) {
    assets.small_image = p.phase
    assets.small_text = fit([away ? 'Away' : PHASE_LABEL[p.phase], ...stats].join(' · '))
  }
  if (Object.keys(assets).length) activity.assets = assets
  return activity
}

// The app's own background jobs (a summary of a chat for the next session)
// run as sessions too; their first prompt gives them away.
const BACKGROUND_PROMPTS = [/^\s*Below is a conversation log from a Claude Code/i]
export const isBackgroundPrompt = (prompt: string) => BACKGROUND_PROMPTS.some(re => re.test(prompt))

// What one session reports: the bridge reads every session's report and shows
// the working ones in turn, or else the one that finished last. A background
// job reports itself as ended, so it is never shown.
export const report = (p: Presence) =>
  p.ended || p.background
    ? { ended: true }
    : { phase: p.phase, since: p.phaseSince, activity: toActivity(p) }

async function publish($: EngineInterface, p: Presence) {
  if (p.statePath) await $.fs.write(p.statePath, JSON.stringify(report(p)))
}

// The chat's title; until it has one, the repository's or project folder's
// name, and nothing for the desktop app's scratch workspace.
export const placeLine = (root: string, repoRoot?: string, chatTitle?: string) => {
  if (chatTitle?.trim()) return `💬 ${chatTitle}`
  if (/[\\/]scratch-workspaces[\\/]/i.test(root)) return ''
  return `📁 ${basename(repoRoot ?? root)}`
}

async function readProject($: EngineInterface, p: Presence) {
  const root = await $.session.root()
  const repo = await $.session.repo().catch(() => null)
  return placeLine(root, repo?.root, p.memo.chatTitle)
}

const memoPath = (statePath: string) => statePath.replace(/[.]json$/, '.memo.json')

async function saveMemo($: EngineInterface, p: Presence) {
  if (p.statePath) await $.fs.write(memoPath(p.statePath), JSON.stringify(p.memo))
}

async function loadMemo($: EngineInterface, statePath: string): Promise<Memo> {
  const text = await $.fs.read(memoPath(statePath)).catch(() => '')
  const memo = text ? (JSON.parse(text) as Partial<Memo>) : {}
  // 0.1.x kept the title alone in a .title file.
  const oldTitle = await $.fs.read(statePath.replace(/[.]json$/, '.title')).catch(() => '')
  return { chatTitle: memo.chatTitle ?? (oldTitle || undefined), files: memo.files ?? [], commands: memo.commands ?? 0 }
}

// The chat's title rides on the classic prompt and start events.
async function takeTitle($: EngineInterface, p: Presence, title: string | undefined) {
  if (!title || title === p.memo.chatTitle) return
  p.memo = { ...p.memo, chatTitle: title }
  note($, p, `chat title: ${title}`)
  await saveMemo($, p)
  p.project = await readProject($, p)
  await publish($, p)
}

// The session's figures: cost, context fill, the 5-hour limit, prompts, agents.
async function refresh($: EngineInterface, p: Presence) {
  const usage = await $.session.usage()
  if (p.showCost) p.costUsd = usage.cost?.usd
  p.contextPercent = usage.context.percent
  const fiveHour = usage.rateLimits.find(limit => limit.kind === 'five_hour')
  p.limit = fiveHour && {
    percent: fiveHour.percentUsed,
    resetsAt: fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : undefined,
  }
  p.prompts = await $.session.turns()
  const agents = await $.agent.list().catch(() => [])
  p.agents = agents.filter(a => ['pending', 'running', 'waiting'].includes(a.status)).length
}

async function refreshAndPublish($: EngineInterface, p: Presence) {
  await refresh($, p).catch(() => {})
  await publish($, p)
}

// --- Notifications to a Discord channel, through its webhook ------------------

export const formatDuration = (ms: number) => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const chatName = (p: Presence) => p.memo.chatTitle?.trim() || p.project.replace(/^\S+ /, '') || 'New chat'

// One message as the channel shows it: "✅ **Моды** — done in 4m 12s"
export const notification = (p: Presence, icon: string, text: string, extra = '') => {
  const body = `${icon} **${chatName(p)}** — ${text}`
  const quote = extra.trim() ? `\n> ${extra.trim().replace(/\s+/g, ' ').slice(0, 300)}` : ''
  return (body + quote).slice(0, 2000)
}

// The channel keeps the history; the bot's direct message is what reaches you.
async function notify($: EngineInterface, p: Presence, content: string) {
  if (p.background) return
  await Promise.all([
    postToChannel($, p, content).catch(err => note($, p, `webhook failed: ${err}`)),
    sendDirect($, p, content).catch(err => note($, p, `direct message failed: ${err}`)),
  ])
}

// With tagInChannel on, a message in a shared channel is led by its owner's
// tag, "@you ✅ …", which only shows whose it is: nobody is ever pinged.
export const channelMessage = (content: string, userId?: string) =>
  (userId ? `<@${userId}> ${content}` : content).slice(0, 2000)

async function postToChannel($: EngineInterface, p: Presence, content: string) {
  if (!p.webhookUrl) return
  const userId = p.tagInChannel ? await discordUserId($, p) : undefined
  // The webhook's own name and avatar, as set in Discord, sign the message.
  const res = await $.http.fetch(p.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: channelMessage(content, userId), allowed_mentions: { parse: [] } }),
  })
  if (!res.ok) note($, p, `webhook answered ${res.status}`)
}

// The Discord user the bridge connected as, kept beside the reports.
async function discordUserId($: EngineInterface, p: Presence) {
  if (!p.statePath) return undefined
  const userFile = p.statePath.replace(/[^\\/]+$/, 'user.json')
  const user = JSON.parse(await $.fs.read(userFile).catch(() => '{}')) as { id?: string }
  return user.id || undefined
}

const DISCORD_API = 'https://discord.com/api/v10'

// The application's bot writes to you directly. Its token is a file you keep
// (never in settings), and your user ID is the one the bridge connected as.
async function sendDirect($: EngineInterface, p: Presence, content: string) {
  if (!p.botTokenPath || !p.statePath) return
  const token = (await $.fs.read(p.botTokenPath).catch(() => '')).trim()
  if (!token) return
  const user = { id: await discordUserId($, p) }
  if (!user.id) {
    note($, p, 'direct message skipped: Discord user not known yet')
    return
  }
  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }
  // Opened once and shared: two at once are refused as "too fast".
  p.dmChannel ??= openDirectChannel($, p, headers, user.id)
  const channel = await p.dmChannel
  if (!channel) {
    p.dmChannel = undefined
    return
  }
  const body = JSON.stringify({ content, allowed_mentions: { parse: [] } })
  const sent = await fetchWithRetry($, `${DISCORD_API}/channels/${channel}/messages`, headers, body)
  if (!sent.ok) note($, p, `direct message answered ${sent.status}: ${sent.text.slice(0, 200)}`)
}

// The direct channel's id is kept beside the reports, so every session and
// every reload reuses it instead of opening it again.
async function openDirectChannel($: EngineInterface, p: Presence, headers: Record<string, string>, userId: string) {
  const cacheFile = p.statePath!.replace(/[^\\/]+$/, 'dm.json')
  const cached = JSON.parse(await $.fs.read(cacheFile).catch(() => '{}')) as { userId?: string; channelId?: string }
  if (cached.userId === userId && cached.channelId) return cached.channelId
  const body = JSON.stringify({ recipient_id: userId })
  const opened = await fetchWithRetry($, `${DISCORD_API}/users/@me/channels`, headers, body)
  if (!opened.ok) {
    note($, p, `opening the direct channel answered ${opened.status}: ${opened.text.slice(0, 200)}`)
    return undefined
  }
  const channelId = (JSON.parse(opened.text) as { id: string }).id
  await $.fs.write(cacheFile, JSON.stringify({ userId, channelId })).catch(() => {})
  return channelId
}

// Discord answers 429, or 400 with code 40003, when asked too fast: wait as
// it says (or two seconds) and try again, at most three times.
async function fetchWithRetry($: EngineInterface, url: string, headers: Record<string, string>, body: string) {
  for (let attempt = 1; ; attempt++) {
    const res = await $.http.fetch(url, { method: 'POST', headers, body })
    const tooFast = res.status === 429 || (res.status === 400 && res.text.includes('40003'))
    if (!tooFast || attempt === 3) return res
    const after = Number((JSON.parse(res.text || '{}') as { retry_after?: number }).retry_after)
    await $.clock.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 10_000) : 2_000)
  }
}

async function notifyTurn($: EngineInterface, p: Presence, reason: string, durationMs: number, answer: string) {
  await refresh($, p).catch(() => {})
  if (reason === 'answer' && durationMs >= p.notifyAfterMs) {
    await notify($, p, notification(p, '✅', `done in ${formatDuration(durationMs)}`, answer))
  } else if (reason === 'error' || reason === 'refusal') {
    await notify($, p, notification(p, '❌', `stopped after ${formatDuration(durationMs)} with an error`))
  }
}

// Keeps the bridge's last lines beside the state file, for troubleshooting.
function note($: EngineInterface, p: Presence, line: string) {
  $.ui.log(`${$.plugin.name}: ${line}`, { to: 'debug' })
  p.log = [...p.log.slice(-49), `${new Date().toISOString()} ${line}`]
  if (p.statePath) void $.fs.write(p.statePath.replace(/\.json$/, '.log'), p.log.join('\n')).catch(() => {})
}

function setDetails($: EngineInterface, p: Presence, text: string, phase: Phase) {
  p.details = text
  if (p.phase !== phase) p.phaseSince = Date.now()
  p.phase = phase
  void start($, p).then(() => refreshAndPublish($, p)).catch(() => {})
}

async function recordTool($: EngineInterface, p: Presence, args: ToolArgs) {
  const memo = countTool(p.memo, args)
  if (memo === p.memo) return
  p.memo = memo
  await saveMemo($, p)
}

// Starts the bridge once, from whichever event comes first.
function start($: EngineInterface, p: Presence) {
  p.starting ??= (async () => {
    if (!p.clientId) {
      $.ui.toast(`${$.plugin.name}: set "Discord Application ID" in the plugin's config to turn it on.`, { timeoutMs: 8000 })
      return
    }
    if ((await $.env.get('OS')) !== 'Windows_NT') return

    const temp = (await $.env.get('TEMP')) ?? $.plugin.root
    const statePath = `${temp}/claude-discord-presence/${await $.session.id()}.json`
    p.statePath = statePath
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (home) p.botTokenPath = `${home}/.claude/discord-presence/bot-token.txt`
    const memo = await loadMemo($, statePath).catch(() => p.memo)
    p.memo = { ...memo, chatTitle: p.memo.chatTitle ?? memo.chatTitle }
    p.project = await readProject($, p)
    p.model = prettyModel(await $.session.model())
    await refreshAndPublish($, p)
    const hasBot = !!p.botTokenPath && !!(await $.fs.read(p.botTokenPath).catch(() => '')).trim()
    note($, p, `started; channel ${p.webhookUrl ? 'on' : 'off'}, direct messages ${hasBot ? 'on' : 'off'}`)

    $.clock.every(HEARTBEAT_MS, () => void refreshAndPublish($, p).catch(() => {}))
    void runBridge($, p, statePath).catch(err => note($, p, `bridge failed: ${err}`))
  })()
  return p.starting
}

async function runBridge($: EngineInterface, p: Presence, statePath: string) {
  // The bridge lives as long as this loop: it ends with the module.
  const bridge = $.process.spawn({
    argv: [
      'powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', `${$.plugin.root}/hooks/discord-rpc.ps1`,
      '-ClientId', p.clientId,
      '-StateFile', statePath,
    ],
  })
  for await (const { text } of bridge) {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      note($, p, line)
      if (line.includes('Invalid Client ID')) {
        $.ui.toast(`${$.plugin.name}: Discord rejected the Application ID; check it in the plugin's config.`, { timeoutMs: 8000 })
      }
    }
  }
}

export const register: Register = (on, options) => {
  const p = newPresence(options)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    p.startedAt = Date.now()
    await start($, p).catch(err => note($, p, `start failed: ${err}`))
    return started
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!p.background && isBackgroundPrompt(e.prompt)) {
      p.background = true
      note($, p, 'background job: hidden, no notifications')
      void publish($, p).catch(() => {})
    }
    await takeTitle($, p, e.session_title).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    await takeTitle($, p, e.session_title).catch(() => {})
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    p.model = prettyModel(await $.session.model())
    p.project = await readProject($, p)
    setDetails($, p, THINKING, 'thinking')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as ToolArgs
    setDetails($, p, describeTool(args, p.showFile), 'working')
    if (args.tool === 'AskUserQuestion') {
      const asked = e as unknown as { questions?: { question?: string }[] }
      const question = asked.questions?.[0]?.question ?? ''
      void notify($, p, notification(p, '❓', 'asks you a question', question)).catch(() => {})
    }
    const result = await next(e)
    if (result.deny === undefined && result.isError !== true) {
      await recordTool($, p, args).catch(() => {})
    }
    if (p.phase !== 'idle') setDetails($, p, THINKING, 'thinking')
    return result
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', async ($, e, next) => {
    // A question is announced as one already; its dialog is no permission.
    if (e.tool_name !== 'AskUserQuestion') {
      void notify($, p, notification(p, '✋', `needs your permission: ${e.tool_name}`)).catch(() => {})
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends inside the main one: only the main loop's end
    // means the chat waits for you.
    if (e.agentId === undefined) {
      setDetails($, p, IDLE, 'idle')
      void notifyTurn($, p, e.reason, e.durationMs, e.answer).catch(() => {})
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // /clear keeps the process: start the clock and the tallies over.
    if (e.reason === 'clear') {
      p.startedAt = Date.now()
      p.memo = { chatTitle: p.memo.chatTitle, files: [], commands: 0 }
      await saveMemo($, p).catch(() => {})
      setDetails($, p, IDLE, 'idle')
    } else {
      p.ended = true
      await publish($, p).catch(() => {})
    }
    return next(e)
  })
}
