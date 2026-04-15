# Tab Out VETA

> **Fork of [Tab Out](https://github.com/zarazhangrui/tab-out) by Zara Zhang**, heavily extended into a personal dashboard.

Pure Chrome/Edge extension (Manifest V3). Your new-tab page, with weather, rates, system metrics, pinned tabs, customisable quick-access shortcuts — 100% local, no server, no accounts.

![Screenshot](docs/screenshot.png)

---

## 🙏 Credit

This project started as a fork of **[Tab Out by Zara Zhang](https://github.com/zarazhangrui/tab-out)** — a minimalist "keep tabs on your tabs" Chrome extension. Zara's original idea and base implementation (domain grouping, landing pages group, confetti close animation, Saved for Later checklist, dupe detection) are preserved. All my additions are built on top of that foundation.

Please star and support [the original project](https://github.com/zarazhangrui/tab-out) too — it solves a real problem elegantly and is worth following.

---

## 🆚 What this fork adds on top of original

| Feature | Original Tab Out | This fork |
|---------|:----:|:----:|
| Domain grouping + landing pages | ✅ | ✅ |
| Close tabs with confetti + swoosh | ✅ | ✅ |
| Duplicate detection | ✅ | ✅ |
| Saved for Later checklist | ✅ | ✅ (migrated from SQLite to chrome.storage) |
| **Quick Access shortcuts** (40+ configurable tiles, drag-drop, edit mode, color/icon picker, import/export) | ❌ | ✅ |
| **Weather widget** (wttr.in — temp, forecast, sunrise/sunset, moon phase) | ❌ | ✅ |
| **Currency rates** (USD/EUR/BTC/ETH/SOL/TON via CBR RF + CoinGecko) | ❌ | ✅ |
| **Air quality (AQI)** via Open-Meteo | ❌ | ✅ |
| **System metrics** (RAM, Disk, CPU load, CPU/GPU temps, GPU load, VRAM, fan RPM — via Libre Hardware Monitor) | ❌ | ✅ |
| **HTTP ping** indicators for configurable hosts | ❌ | ✅ |
| **Speedtest** (Cloudflare) on demand | ❌ | ✅ |
| **Pinned tabs** (tab stays open but hidden from Open Tabs grid) | ❌ | ✅ |
| **Themes** (light / dark / auto by sunrise-sunset) + auto-adapt dark brand colors | ❌ | ✅ |
| **Settings modal** (city picker with autocomplete, currencies, ping hosts, system metric toggles, tile scale, tab title, backup/restore) | ❌ | ✅ |
| Custom scrollbars matching the theme | ❌ | ✅ |
| Visibility-aware polling (intervals pause when tab is backgrounded) | ❌ | ✅ |

## 🧰 Architecture changes vs original

- **Original** (at the fork point, commit `656f6b3`) had a Node.js + Express server with SQLite, communicated with the new-tab page via a postMessage bridge.
- **This fork** migrated everything into the pure Chrome extension — no server, no Node, no npm. All state lives in `chrome.storage.local`.
- After my fork, [Zara also migrated](https://github.com/zarazhangrui/tab-out/commit/9b800f6) to a pure extension architecture — great minds think alike 🙂.

## 📥 Install

```bash
git clone https://github.com/Veta-one/tab-out-veta.git
```

1. Open `edge://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Open a new tab.

## ⚙️ System metrics (optional)

The CPU/GPU temperatures and CPU/GPU load metrics require [**Libre Hardware Monitor**](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases) running with its remote web server enabled on port 8085. Otherwise they simply won't show up.

## 📦 Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | `chrome.storage.local` (mirrored in-memory for sync reads) |
| Fonts | DM Sans + Newsreader (Google Fonts) |
| Weather icons | [erikflowers/weather-icons](https://github.com/erikflowers/weather-icons) (CDN) |
| Brand icons | Simple Icons + a handful of custom SVGs |
| Data sources | wttr.in, Open-Meteo (geocoding, AQI), CBR RF, CoinGecko, Cloudflare speedtest, nager.at (holidays), LHM (system metrics) |

## 📜 License

MIT — same as the original project. Both copyright notices preserved in `LICENSE`. You're free to fork this fork, extend it further, etc.

---

Made by VETA, standing on the shoulders of Zara's work.
