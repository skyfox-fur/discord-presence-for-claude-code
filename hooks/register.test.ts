import { test, expect } from 'claude-code/testing'
import { basename, contextBar, countTool, describeTool, newPresence, placeLine, prettyModel, toActivity } from './register'

const raw = String.raw

test('names models the way people say them', async () => {
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5')
})

test('names the chat, else the project', async () => {
  const scratch = raw`C:\Users\me\AppData\Roaming\Claude\scratch-workspaces\a\b\scratch-2026-01-01-abcdef`
  expect(placeLine(raw`E:\repos\yandex_tracker_mcp`)).toBe('📁 yandex_tracker_mcp')
  expect(placeLine(raw`E:\rms\.worktrees\fix`, raw`E:\rms`)).toBe('📁 rms')
  expect(placeLine(scratch, undefined, 'Моды')).toBe('💬 Моды')
  expect(placeLine(scratch)).toBe('')
  expect(placeLine('E:/rms', undefined, 'GTP-575 анализ')).toBe('💬 GTP-575 анализ')
  expect(placeLine('E:/rms', undefined, '  ')).toBe('📁 rms')
})

test('describes the current action', async () => {
  const file = raw`C:\src\app\main.ts`
  expect(describeTool({ tool: 'Edit', file_path: file }, true)).toBe('Editing main.ts')
  expect(describeTool({ tool: 'Edit', file_path: file }, false)).toBe('Editing code')
  expect(describeTool({ tool: 'Bash' }, true)).toBe('Running a command')
  expect(describeTool({ tool: 'mcp__yandex-tracker__get_issue' }, true)).toBe('Using yandex-tracker')
  expect(basename('/home/me/project/')).toBe('project')
})

test('counts distinct files edited and commands run', async () => {
  let memo = { files: [] as string[], commands: 0 }
  memo = countTool(memo, { tool: 'Edit', file_path: 'a.ts' })
  memo = countTool(memo, { tool: 'Write', file_path: 'a.ts' })
  memo = countTool(memo, { tool: 'Write', file_path: 'b.ts' })
  memo = countTool(memo, { tool: 'Bash' })
  memo = countTool(memo, { tool: 'Read', file_path: 'c.ts' })
  expect(memo.files).toEqual(['a.ts', 'b.ts'])
  expect(memo.commands).toBe(1)
})

const busy = () => ({
  ...newPresence({ clientId: '1', largeImage: 'logo', stateIcons: true }),
  startedAt: 1000, project: '💬 Моды', model: 'Opus 5.5', details: 'Editing main.ts',
  phase: 'working' as const, costUsd: 1.234, contextPercent: 61.6, prompts: 12, agents: 3,
  memo: { files: ['a', 'b'], commands: 1 },
  limit: { percent: 40, resetsAt: 9_000 },
})

test('shows the session in every place Discord has', async () => {
  const a = toActivity(busy(), 5_000)
  expect(a.details).toBe('Editing main.ts · 🤖 3')
  expect(a.state).toBe('💬 Моды · $1.23 · ▰▰▰▱▱')
  expect(a.type).toBe(0)
  expect(a.status_display_type).toBe(2)
  expect(a.timestamps).toEqual({ start: 1000 })
  expect(a.assets?.large_text).toBe('Claude Code · Opus 5.5')
  expect(a.assets?.small_image).toBe('working')
  expect(a.assets?.small_text).toBe('Working · context 62% · 12 prompts · 2 files edited · 1 command · 5h limit 40%')
  const noIcons = toActivity({ ...busy(), stateIcons: false }, 5_000)
  expect(noIcons.assets?.large_text).toBe('Claude Code · Opus 5.5 · context 62% · 12 prompts · 2 files edited · 1 command · 5h limit 40%')
  expect(noIcons.assets?.small_image).toBeUndefined()
})

const idle = () => ({ ...busy(), phase: 'idle' as const, details: 'Waiting for a prompt', agents: 0, phaseSince: 4_000 })

test('plays while waiting and counts down to the limit reset when it is nearly used up', async () => {
  const waiting = toActivity({ ...idle(), limit: { percent: 40, resetsAt: 9_000 } }, 5_000)
  expect(waiting.type).toBe(0)
  expect(waiting.timestamps).toEqual({ start: 1000 })
  expect(toActivity({ ...idle(), limit: { percent: 85, resetsAt: 9_000 } }, 5_000).timestamps).toEqual({ end: 9_000 })
  expect(toActivity({ ...idle(), limit: { percent: 85, resetsAt: 4_000 } }, 5_000).timestamps).toEqual({ start: 1000 })
})

test('plays with the session timer while working, whatever the limit', async () => {
  for (const limit of [undefined, { percent: 40, resetsAt: 9_000 }, { percent: 95, resetsAt: 9_000 }]) {
    const a = toActivity({ ...busy(), limit }, 5_000)
    expect(a.type).toBe(0)
    expect(a.timestamps).toEqual({ start: 1000 })
  }
})

test('shows Away after the set idle time, timed from when it went idle', async () => {
  const minute = 60_000
  const p = { ...idle(), afkMs: 15 * minute, phaseSince: 100_000 }
  expect(toActivity(p, 100_000 + 14 * minute).details).toBe('Waiting for a prompt')
  const away = toActivity(p, 100_000 + 15 * minute)
  expect(away.details).toBe('💤 Away')
  expect(away.timestamps).toEqual({ start: 100_000 })
  expect(away.assets?.small_text?.startsWith('Away')).toBe(true)
  expect(toActivity({ ...p, afkMs: 0 }, 100_000 + 99 * minute).details).toBe('Waiting for a prompt')
  expect(toActivity({ ...busy(), afkMs: 1, phaseSince: 0 }, 10 * minute).details).not.toContain('Away')
})

test('keeps to the basics with stats and icons off', async () => {
  const a = toActivity({ ...busy(), showStats: false, stateIcons: false, showCost: false, agents: 0, details: 'x'.repeat(200) })
  expect(a.details.endsWith('…')).toBe(true)
  expect(a.state).toBe('💬 Моды')
  expect(a.assets).toEqual({ large_image: 'logo', large_text: 'Claude Code · Opus 5.5' })
})

test('draws the context fill as a bar', async () => {
  expect(contextBar(0)).toBe('▱▱▱▱▱')
  expect(contextBar(25)).toBe('▰▱▱▱▱')
  expect(contextBar(100)).toBe('▰▰▰▰▰')
})

import { channelMessage, detailsLine, formatCost, formatDuration, isBackgroundPrompt, notification, report, LINE_WIDTH, stateLine, textWidth, truncateFile } from './register'

test('writes costs in at most five characters', async () => {
  expect(formatCost(0)).toBe('$0.00')
  expect(formatCost(8.567)).toBe('$8.57')
  expect(formatCost(9.999)).toBe('$10.0')
  expect(formatCost(85.71)).toBe('$85.7')
  expect(formatCost(123.4)).toBe('$123')
  expect(formatCost(1234)).toBe('$1.2k')
  expect(formatCost(20000)).toBe('$20k')
})

test('fits the state line in every case', async () => {
  const titles = ['Моды', 'Рефакторинг модуля авторизации и сессий', 'WWWWWWWWWWWWWWWWWWWWWWWW', '🐺🦊🐱🐶🐭🐹🐰🦝🐻🐼', '  пробелы \n  и перенос  ', 'a', '中文标题很长很长很长很长']
  const costs = ['', '$8.57', '$85.7', '$123', '$1.2k']
  const bars = ['', '▰▰▱▱▱', '▰▰▰▰▰']
  for (const title of titles) for (const icon of ['💬 ', '📁 ', '']) for (const cost of costs) for (const bar of bars) {
    const line = stateLine(icon + title, cost, bar)
    expect(textWidth(line)).toBeLessThanOrEqual(LINE_WIDTH)
    expect(line).not.toMatch(/\s{2}|\n/)
  }
})

test('keeps a short name whole and shortens a long one', async () => {
  expect(stateLine('💬 Моды', '$8.57', '▰▰▱▱▱')).toBe('💬 Моды · $8.57 · ▰▰▱▱▱')
  const long = stateLine('💬 Рефакторинг модуля авторизации', '$8.57', '▰▰▱▱▱')
  expect(long.startsWith('💬 Реф')).toBe(true)
  expect(long).toContain('… · $8.57 · ▰▰▱▱▱')
  expect(stateLine('', '$8.57', '▰▰▱▱▱')).toBe('$8.57 · ▰▰▱▱▱')
  expect(stateLine('', '', '')).toBe('')
})

test('fits the first line, keeping a file extension', async () => {
  expect(detailsLine('Waiting for a prompt', 0)).toBe('Waiting for a prompt')
  expect(detailsLine('Waiting for a prompt', 3)).toMatch(/· 🤖 3$/)
  const edit = detailsLine('Editing SessionAuthorizationMiddleware.cs', 2)
  expect(edit).toMatch(/^Editing Session.*….cs · 🤖 2$/)
  for (const d of ['Using yandex-tracker-very-long-server-name', 'Delegating to a subagent', 'Reading ' + 'x'.repeat(200) + '.json']) {
    for (const n of [0, 1, 12]) expect(textWidth(detailsLine(d, n))).toBeLessThanOrEqual(LINE_WIDTH)
  }
  expect(truncateFile('README', 4)).toBe('REA…')
})

test('reports the phase and when it began, or that the session ended', async () => {
  const r = report({ ...busy(), phaseSince: 7_000 }) as { phase: string; since: number; activity: { state: string } }
  expect(r.phase).toBe('working')
  expect(r.since).toBe(7_000)
  expect(r.activity.state).toBe('💬 Моды · $1.23 · ▰▰▰▱▱')
  expect(report({ ...busy(), ended: true })).toEqual({ ended: true })
})

test('writes notifications the channel can read', async () => {
  expect(formatDuration(42_000)).toBe('42s')
  expect(formatDuration(252_000)).toBe('4m 12s')
  expect(formatDuration(3_900_000)).toBe('1h 5m')
  const p = { ...busy(), memo: { chatTitle: 'Моды', files: [], commands: 0 }, costUsd: 3.2 }
  expect(notification(p, '✅', 'done in 4m 12s')).toBe('✅ **Моды** — done in 4m 12s')
  expect(notification(p, '❓', 'asks you a question', 'Which\n  option?')).toBe('❓ **Моды** — asks you a question\n> Which option?')
  const noTitle = { ...busy(), memo: { files: [], commands: 0 }, project: '📁 rms', costUsd: undefined }
  expect(notification(noTitle, '✋', 'needs your permission: Bash')).toBe('✋ **rms** — needs your permission: Bash')
  expect(notification(p, '✅', 'done', 'x'.repeat(5000)).length).toBeLessThanOrEqual(2000)
})

test('tells the app background jobs from chats', async () => {
  expect(isBackgroundPrompt('Below is a conversation log from a Claude Code coding session. Create a summary')).toBe(true)
  expect(isBackgroundPrompt('Помоги с модом для Discord')).toBe(false)
  expect(report({ ...busy(), background: true })).toEqual({ ended: true })
  const untitled = { ...busy(), memo: { files: [], commands: 0 }, project: '' }
  expect(notification(untitled, '✅', 'done')).toBe('✅ **New chat** — done')
})

test('leads a channel message with its owner tag', async () => {
  expect(channelMessage('✅ **Моды** — done', '123456789012345678')).toBe('<@123456789012345678> ✅ **Моды** — done')
  expect(channelMessage('✅ done')).toBe('✅ done')
  expect(channelMessage('x'.repeat(2000), '1').length).toBe(2000)
})
