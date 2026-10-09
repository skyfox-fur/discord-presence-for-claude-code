# Discord Presence for Claude Code

> **Unofficial.** Not made by, affiliated with or endorsed by Anthropic or Discord.

Shows what [Claude Code](https://claude.com/claude-code) is doing as your Discord status, and tells you in Discord when a long task finishes or Claude needs you.

```
Playing ClaudeCode
Editing register.ts · 🤖 2
💬 Refactor auth · $8.57 · ▰▰▱▱▱
0:16 elapsed
```

## Features

**Status (Rich Presence)**

- **What Claude is doing right now:** `Thinking…`, `Editing main.ts`, `Running a command`, `Searching the code`, `Waiting for a prompt`, with running subagents as `🤖 2`.
- **Where and how much:** the chat's title (or the project folder), the session's cost and a context-window bar `▰▰▱▱▱`.
- **Member list:** your name in a server's member list shows the current action instead of just the app's name.
- **State icon:** a small moon, dots or bolt for waiting, thinking or working. Its tooltip holds the details: context fill, prompts, files edited, commands run, the 5-hour limit.
- **Limit countdown:** when the 5-hour limit is over 80% used, the timer counts down to its reset.
- **Away:** after 15 minutes without a prompt the status turns to `💤 Away`.
- **Several chats at once:** chats that are working take turns every 10 seconds. When all of them wait, the one that finished last is shown.
- **Always fits:** both lines are fitted to the profile card's width. Long names are shortened, and a file keeps its extension.

**Notifications** (optional)

- ✅ a task that ran at least a minute is done, with the start of Claude's answer;
- ❓ Claude asks you a question;
- ✋ Claude needs your permission;
- ❌ a task stopped with an error.

They go to a channel of yours through a webhook, to your DMs through your own bot, or both.

## Requirements

- **Windows.** The bridge to Discord is a PowerShell script for now. macOS and Linux are planned.
- The Discord desktop app, running.
- Claude Code with plugin support (function-hook mods). That API is in early access and may change between Claude Code releases.

## Install

In a terminal, run `claude` and enter:

```
/plugin install discord-presence --marketplace skyfox-fur/discord-presence-for-claude-code
```

Answer `y` to add the marketplace, choose the **user** scope, and set the options you want. The status shows up in Discord with your next prompt.

The plugin then runs in every Claude Code session, including the desktop app's Code tab and IDE extensions.

## Options

Change them in `/config` (terminal), or in `~/.claude/settings.json` under `pluginConfigs."discord-presence".options`.

| Option | Default | What it does |
|---|---|---|
| `showProject` | on | The chat's title, or the project folder, on the second line. |
| `showFile` | **off** | File names in the action (`Editing main.ts`). Anyone who can see your profile sees them. |
| `showCost` | on | The session's cost on the second line. |
| `showStats` | on | The context bar, the limit countdown and the figures in the icon's tooltip. |
| `stateIcons` | on | The small waiting / thinking / working icon. |
| `afkMinutes` | 15 | Minutes without a prompt before `💤 Away`. `0` turns it off. |
| `webhookUrl` | — | A channel webhook for notifications. |
| `tagInChannel` | off | Lead each channel message with your Discord tag (no ping), for a channel several people share. |
| `notifyAfterSeconds` | 60 | Only tasks that ran at least this long are announced as done. Questions, permission requests and errors are always announced. |
| `clientId`, `largeImage` | this project's app | Use your own Discord application and image instead. |

## Notifications

### To a channel (webhook)

1. In your server: **Server Settings → Integrations → Webhooks → New Webhook**, pick a channel, then **Copy Webhook URL**.
2. Put the URL in the `webhookUrl` option.

Keep the URL private: anyone who has it can post in that channel.

To keep the channel quiet for everyone else, hide it: **Edit Channel → Permissions → @everyone → View Channel ✕**.

### To your DMs (your own bot)

A bot can only DM you if it shares a server with you, and only the holder of its token can make it write. So it has to be **your own** bot:

1. In the [Discord Developer Portal](https://discord.com/developers/applications) create an application and open **Bot**. Set a name and an avatar if you like ([`assets/bot-avatar.png`](assets/bot-avatar.png)), then **Reset Token** and copy the token.
2. Save the token, and nothing else, in `~/.claude/discord-presence/bot-token.txt` (`%USERPROFILE%\.claude\discord-presence\bot-token.txt` on Windows).
3. Add the bot to one of your servers, with no permissions: `https://discord.com/oauth2/authorize?client_id=<your application id>&scope=bot&permissions=0`.

The plugin learns your Discord user ID from the Discord app it is connected to. The token never leaves your computer, and is never stored in settings.

## Privacy

What goes to Discord: the action (and, with `showFile`, the file name), the chat's title or project folder, the cost, the context fill and the figures above. With notifications on, also the start of Claude's final answer and the text of its questions. Nothing else, and nowhere else: there is no server in between.

## How it works

The plugin hooks Claude Code's events (prompt, tool calls, turn end, session start and end). Each session writes a small report of itself to `%TEMP%\claude-discord-presence\`. Every session also starts `hooks/discord-rpc.ps1`, but only one of them takes a system-wide lock and talks to Discord over its local IPC pipe. That one reads all reports and picks which session to show. When it exits, the next one takes over.

Background sessions the desktop app runs for itself (chat summaries) are recognized and neither shown nor announced.

## Use your own Discord application

The default application gives everyone the same name and icons. To use your own:

1. Create an application in the Developer Portal. Its name is what Discord shows as "Playing …".
2. Under **Rich Presence → Art Assets** upload `assets/idle.png`, `assets/thinking.png` and `assets/working.png` with the keys `idle`, `thinking`, `working`, and an icon for `largeImage` (an asset key, or an `https://` image URL).
3. Set `clientId` to the application's ID and `largeImage` to the icon's key or URL.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`claude --plugin-dir .` runs the plugin from this folder for one session. `CLAUDE_CODE_PLUGIN_DIRS` does the same for sessions the desktop app starts. The tests (`hooks/register.test.ts`) cover how both lines are worded and fitted, the activity's timers, the notifications' text and the background-job filter.

## License

[MIT](LICENSE)
