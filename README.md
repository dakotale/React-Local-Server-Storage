# CloudStorage

A self-hosted file storage app. Run it on one machine and access it from any browser on your local network. Includes folders, tags, file preview, and an AI assistant powered by Claude.

![Dark UI with sidebar, file grid, and chat widget](https://placeholder)

## Features

- **Upload** — drag & drop or click to browse, up to 500 MB per file
- **Preview** — images, video, audio, PDF, and text/code render inline before downloading
- **Folders** — create folders, upload directly into them; folders persist even when empty
- **Tags** — tag files from the card or preview modal; filter by one or more tags
- **Sort** — by date, name, or size
- **Search** — filters by filename or tag in real-time
- **AI chat** — floating assistant powered by Claude (requires Anthropic API key)
- **Network access** — the server binds to `0.0.0.0` so any device on your LAN can reach it; your IP is shown in the header

## Stack

| Layer | Tech |
|---|---|
| Backend | Node.js · Express · Multer |
| Frontend | AngularJS 1.8 (no build step) |
| Storage | Local disk + JSON metadata |
| AI | Anthropic Claude via `@anthropic-ai/sdk` |

## Setup

### Prerequisites

- [Node.js](https://nodejs.org) 18 or later

### Installation

```bash
git clone https://github.com/your-username/cloud-storage.git
cd cloud-storage
npm install
```

### Configuration

```bash
cp .env.example .env
```

Open `.env` and add your [Anthropic API key](https://console.anthropic.com). The app runs without it — chat will just be disabled.

```
ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). The terminal prints your local network IP — share that URL with other devices on the same Wi-Fi.

## Project structure

```
server.js          Express backend
public/
  index.html       AngularJS template
  app.js           Controllers and directives
  style.css        Styles
uploads/           Uploaded files (git-ignored, auto-created)
metadata.json      File metadata (git-ignored, auto-created)
folders.json       Folder list (git-ignored, auto-created)
.env               Your secrets (git-ignored)
.env.example       Template for .env
```

## Security notes

- **No authentication** — designed for trusted local networks only. Do not expose this server directly to the public internet without adding an auth layer.
- The Anthropic API key is stored server-side in `.env` and never sent to the browser.
- File IDs are random 32-character hex strings; the original filename is never used for disk operations.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | No | — | Enables the AI chat assistant |
| `PORT` | No | `3000` | Port the server listens on |
