# Tab Out

**Keep tabs on your tabs.**

Tab Out replaces your Chrome new tab page with a dashboard that shows everything you have open — grouped by what you're actually doing. Click a button and AI organizes your tabs into named missions, writes you a witty one-liner about your browsing habits, and lets you close entire missions with a satisfying swoosh + confetti.

Built for people who open too many tabs and never close them.

---

## Install with a coding agent

Send your coding agent (Claude Code, Cursor, Windsurf, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will explain what Tab Out does, walk you through choosing an LLM provider, and set everything up. Takes about 2 minutes.

---

## Features

- **See all your tabs at a glance** — grouped by domain on a clean grid, no more squinting at 30 tiny tab titles
- **"Organize with AI"** — one click and your tabs get clustered into named missions like *"Researching Voice AI"* or *"Setting up Stripe billing"*
- **Witty AI commentary** — the AI writes you a personal one-liner about your tab habits every time you organize
- **Close tabs with style** — swoosh sound + confetti burst when you clean up a mission. Makes tab hygiene feel rewarding
- **Duplicate detection** — flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** — no new tab opened, just switches to the existing one
- **Most visited sites** — your top sites from the past week, right on the new tab page
- **Custom grouping rules** — teach the AI your preferences in plain English
- **Works with any LLM** — DeepSeek, OpenAI, Grok, Gemini, Claude (via OpenRouter), Kimi, GLM, ByteDance Seed, Minimax, Ollama, or any OpenAI-compatible API
- **Auto-updates** — get notified when a new version is available, update with one click
- **100% local** — your browsing data never leaves your machine. Only tab titles and URLs are sent to the AI when you click the button
- **Always on** — starts automatically when you log in, runs silently in the background
- **Zero tokens by default** — the new tab page loads instantly with no AI call. Tokens are only used when you click "Organize with AI"

---

## Manual Setup

If you prefer to set things up yourself instead of using a coding agent:

**1. Clone and install**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
cd tab-out
npm install
```

**2. Run the setup script**

```bash
npm run install-service
```

This creates `~/.mission-control/`, writes a default config, and installs an auto-start service for your platform (macOS Launch Agent, Linux systemd, or Windows Startup script).

**3. Add your API key**

Open `~/.mission-control/config.json` and set your LLM provider:

```json
{
  "apiKey": "your-api-key",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat"
}
```

DeepSeek is the default and cheapest option (fractions of a cent per call). To use a different provider, change `baseUrl` and `model` to match their API. Tab Out works with any OpenAI-compatible API.

**4. Load the Chrome extension**

1. Go to `chrome://extensions` in Chrome
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

**5. Start the server**

```bash
npm start
```

Open a new tab — you'll see Tab Out. The server auto-starts on future logins.

---

## Custom Grouping Rules

You can teach Tab Out how you like your tabs organized by adding `customPromptRules` to your config file. Write plain English — the AI follows your instructions.

```json
{
  "customPromptRules": "Treat all social media as one mission called 'Doom Scrolling'. Group GitHub tabs by repository."
}
```

More examples:
- `"I'm a student. Group tabs by course/subject."`
- `"Always group Google Docs by project name, not by domain."`
- `"Each YouTube video should be its own mission."`

---

## Configuration

Config lives at `~/.mission-control/config.json`:

| Field | Default | What it does |
|-------|---------|-------------|
| `apiKey` | *(empty)* | Your LLM API key |
| `baseUrl` | `https://api.deepseek.com` | Your LLM provider's endpoint |
| `model` | `deepseek-chat` | Which model to use (pick something cheap/fast) |
| `customPromptRules` | *(empty)* | Your custom tab grouping instructions |
| `port` | `3456` | Local port for the dashboard |
| `batchSize` | `200` | How many history entries to process |
| `historyDays` | `7` | How far back to look for most-visited sites |

---

## How it works

```
You open a new tab
  → Chrome extension loads Tab Out in an iframe
  → Dashboard shows your open tabs grouped by domain (instant, free)
  → You click "Organize with AI"
  → Dashboard sends tab titles + URLs to your LLM
  → LLM clusters them into named missions + writes a personal message
  → Results are cached — same tabs next time = instant load, zero tokens
  → You close missions you're done with (swoosh + confetti)
  → Repeat
```

The server runs silently in the background. It starts on login and restarts if it crashes. You never think about it.

---

## Tech stack

| What | How |
|------|-----|
| Server | Node.js + Express |
| Database | better-sqlite3 (local SQLite) |
| AI | Any OpenAI-compatible API |
| Extension | Chrome Manifest V3 |
| Auto-start | macOS Launch Agent / Linux systemd / Windows Startup |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
