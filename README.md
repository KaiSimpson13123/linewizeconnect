# Linewize Connect — Live Screen Monitoring Console

A peer-to-peer classroom screen monitoring console and reverse proxy server engineered for Linewize Connect. It provides a real-time WebRTC stream viewer, live tab inspection, and an integrated reverse proxy to eliminate cross-origin (CORS) restrictions.

Deployable immediately to **Vercel** or runnable locally as a zero-dependency **Node.js** server.

---

## Features

- **Live Screen Telemetry**: High-frequency peer-to-peer JPEG/PNG frame rendering via WebRTC data channels with frame rate (FPS) and latency monitoring.
- **Tab Management**: Displays open tabs on the student's device and supports remote active tab switching.
- **Built-in CORS Reverse Proxy**: Transparently relays Linewize Configuration Gateway (`https://configuration-gw.*.linewize.net`) requests and streams Server-Sent Events (SSE) from Linewize Event Service.
- **Password Protection**: Built-in authentication lock screen gate and server-side token enforcement protecting the console and all proxy APIs. Configurable via `SITE_PASSWORD`.
- **Enterprise Design System**: Strict 8-point spacing scale, typography, and focused contrast without visual noise or extraneous animations.
- **Universal Deployment**: Zero-config deployment on Vercel via Serverless Functions, or standalone execution on Node.js 18+.

---

## 🔒 Password Protection & Security

The entire application (both the frontend console and all backend proxy APIs) is password-protected.

- **Default Password**: `admin`
- **Configuring Custom Password**:
  - **On Vercel**: Go to **Project Settings** → **Environment Variables** → Add `SITE_PASSWORD` with your desired secret password.
  - **Locally**: Set `SITE_PASSWORD=your_secret_password` in your environment or start with:
    ```bash
    SITE_PASSWORD=my_secure_password npm start
    ```
- **Session**: Successful authentication issues a secure SHA-256 session cookie valid for 7 days. You can lock or revoke the session at any time via the **Lock** button in the top navigation bar.

---

## Quick Start (Local)

### Prerequisites
- Node.js 18+ (Node 20+ or 24+ recommended)

### 1. Start the Server
```bash
npm start
```
*Or during development with watch mode:*
```bash
npm run dev
```

### 2. Open Console
Navigate to **[http://localhost:3000](http://localhost:3000)** in your browser.

---

## Deploy to Vercel

This repository includes native Vercel configuration (`vercel.json`) and Serverless API functions in `/api`:

### Option 1: Via Vercel CLI
```bash
npm install -g vercel
vercel
```

### Option 2: Via GitHub Import
1. Push this repository to GitHub.
2. Go to your [Vercel Dashboard](https://vercel.com/dashboard) and click **"Add New Project"**.
3. Import your GitHub repository.
4. Leave all build settings as default (Framework Preset: **Other**, Build Command: empty).
5. Click **Deploy**.

---

## Push to GitHub

To push this repository to GitHub:

```bash
# 1. Initialize git (if not already done)
git init

# 2. Stage all files
git add .

# 3. Create initial commit
git commit -m "feat: initial commit for Linewize Connect screen monitor"

# 4. Link your remote GitHub repository
git remote add origin https://github.com/<your-username>/<your-repo-name>.git

# 5. Push to main branch
git branch -M main
git push -u origin main
```

---

## Architecture & CORS Elimination

When run in a web browser without an extension background page, direct requests to Linewize infrastructure are blocked:
1. `https://configuration-gw.*.linewize.net` does not provide `Access-Control-Allow-Origin` headers.
2. Linewize Event Service (`https://events.*.linewize.net`) drops cross-origin `EventSource` connections.

### Solution Flow
```
[ Browser UI ]
      │
      ├── (HTTP / JSON) ──────────► [ /api/proxy?url=... ] ─────────► [ Linewize Gateway ]
      │                                    │                                    │
      │                             (Adds CORS Headers)                  (Returns Config)
      │                                    │                                    │
      ├── (Server-Sent Events) ───► [ /api/sse?url=... ] ───────────► [ Linewize Events ]
      │                                    │                                    │
      │                             (Streams SSE data)                   (Emits INIT_P2P)
      │                                    │                                    │
      ▼                                    ▼                                    ▼
[ WebRTC P2P DataChannels ] ◄─────────────────────────────────────► [ Student Peer Agent ]
```

---

## API Endpoints

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/` or `/index.html` | `GET` | Main live screen monitoring console. |
| `/api/status` | `GET` | Health status and diagnostic telemetry. |
| `/api/proxy?url=<target>` | `GET/POST` | Transparent CORS proxy forwarding required headers (`X-Actor-Id`, `baggage`). |
| `/api/sse?url=<target>` | `GET` | Streaming proxy for Server-Sent Events with keep-alive. |
| `/api/gateway` | `GET` | Regional gateway shortcut handler. |

---

## Project Structure

```
├── api/                   # Vercel Serverless Functions
│   ├── gateway.js         # Regional gateway shortcut proxy
│   ├── proxy.js           # General CORS HTTP reverse proxy
│   ├── sse.js             # Dedicated SSE stream relay
│   └── status.js          # Healthcheck & telemetry
├── index.html             # Main production entrypoint (clean enterprise UI)
├── live_screen_view.html  # Application HTML (synchronized with index.html)
├── live_screen_view.js    # WebRTC, Ably signaling, & P2P Stream Client
├── server.js              # Standalone Node.js HTTP & reverse proxy server
├── start.bat              # Windows 1-click launcher script
├── vercel.json            # Vercel routing and CORS headers configuration
├── .gitignore             # Git ignore configuration
├── LICENSE                # MIT License
└── package.json           # Node.js project metadata
```

---

## License

This project is licensed under the [MIT License](LICENSE).
