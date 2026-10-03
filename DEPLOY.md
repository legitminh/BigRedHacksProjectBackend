# Deploy Waypoint API on any server

This guide gets the Waypoint API running on a **powerful Linux (or macOS) host** so end-user Mac apps can sign in with Google, sync data, use Copilot (Gemini + local Ollama fallback), and run lock-in coaching through your server.

Sibling desktop repo: [BigRedHacksProject](https://github.com/legitminh/BigRedHacksProject) — see that repo’s README / `docs/BACKEND.md` for **building the Mac app against this API’s public URL**.

---

## Architecture (what lives where)

| Piece | Runs on | Secrets |
|---|---|---|
| Waypoint API (`:8787` behind HTTPS) | **Your server** | Google OAuth, `SESSION_SECRET`, `GEMINI_API_KEY`, `DATABASE_URL`, `ADMIN_PASSWORD`, Ollama |
| Ollama (lock-in + Copilot fallback) | **Same server** (or GPU sibling on private network) | None in the Mac app |
| Postgres / TigerData | Managed DB or self-hosted | `DATABASE_URL` on the API only |
| Waypoint.app (Mac) | End-user machines | Only `waypoint_api_base` (+ optional coach/Presage). **No Gemini / Google secrets** |

End users never install Node, Ollama, or `.env` files. They download a Mac build that already points at your `PUBLIC_BASE_URL`.

---

## 1) Server requirements

- **OS:** Linux x86_64 or arm64 (Ubuntu 22.04+ recommended), or macOS for a lab machine
- **CPU/RAM:** Prefer ≥8 GB RAM if you run `qwen2.5:7b` for Copilot fallback; 16 GB+ is comfortable
- **Disk:** ≥20 GB free (Ollama models: ~5 GB for `qwen2.5:7b`, plus tiny coach models)
- **Network:** Public HTTPS hostname (e.g. `https://api.example.com` or `https://example.com`)
- **Node.js:** **22+**
- **Reverse proxy:** nginx or Caddy terminating TLS (recommended). Keep Node on `127.0.0.1:8787`

---

## 2) Install runtime + Ollama

```bash
# Node 22 (example: NodeSource / nvm / your distro package)
node -v   # must be v22+

# Ollama — https://ollama.com/download
curl -fsSL https://ollama.com/install.sh | sh
ollama serve   # or enable the systemd/brew service

# Models on the API host
ollama pull qwen2.5:0.5b    # fast lock-in coach
ollama pull moondream       # rare local vision
ollama pull qwen2.5:7b      # Copilot fallback when Gemini is quota’d / down
```

Confirm:

```bash
curl -s http://127.0.0.1:11434/api/tags | head
```

---

## 3) Clone and configure the API

```bash
git clone https://github.com/legitminh/BigRedHacksProjectBackend.git
cd BigRedHacksProjectBackend
npm install
cp .env.example .env
```

### Required `.env` for production

Generate secrets:

```bash
openssl rand -base64 32    # → SESSION_SECRET
openssl rand -hex 24       # → COACH_API_TOKEN (optional; JWTs preferred after Google sign-in)
openssl rand -base64 48 | tr -dc A-Za-z0-9 | head -c 32   # → ADMIN_PASSWORD
```

Fill at least:

```env
PORT=8787
# Same host as nginx/Caddy → keep loopback (recommended)
BIND_HOST=127.0.0.1
# Public URL clients + Google OAuth use (no trailing slash)
PUBLIC_BASE_URL=https://api.example.com

GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=....
SESSION_SECRET=....          # ≥32 characters

# TigerData / Postgres (multi-user production). Leave empty only for single-box file store.
DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DB?sslmode=require

GEMINI_API_KEY=....
GEMINI_MODEL=gemini-flash-latest

# Study heads-up / nudge spoken audio (Grok TTS). Optional — desktop falls back to macOS `say`.
XAI_API_KEY=....
XAI_TTS_VOICE=eve

OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:0.5b
OLLAMA_VISION_MODEL=moondream
OLLAMA_CHAT_MODEL=qwen2.5:7b
OLLAMA_CHAT_NUM_CTX=16384

COACH_API_TOKEN=....         # optional
ADMIN_PASSWORD=....          # /admin console
```

Notes:

- **`PUBLIC_BASE_URL` must be `https://…` in production.** Desktop apps and Google redirects use this exact origin.
- **`BIND_HOST=127.0.0.1`** when nginx/Caddy is on the same machine. Only use `0.0.0.0` if the API is on a private network behind a separate proxy — then firewall `:8787` from the public internet.
- Copilot: Gemini first; on quota / outage the API **silently** uses `OLLAMA_CHAT_MODEL` so users do not see “cloud coach hit the limit.”

See `.env.example` for every variable.

---

## 4) Google Cloud (Web OAuth client)

Create a **Web application** OAuth client (not “Desktop”):

1. [Google Cloud Console](https://console.cloud.google.com/) → your project  
2. Enable **Google Calendar API** and **Google Drive API**  
3. OAuth consent screen (External / Testing is fine for a hackathon)  
4. Credentials → OAuth client ID → **Web application**  
5. Authorized redirect URIs (**must match `PUBLIC_BASE_URL`**):

```text
https://api.example.com/v1/auth/google/callback
https://api.example.com/v1/google/calendar/callback
```

6. Put client id/secret only in the server `.env` — **never** in the Mac app’s `secrets.toml`.

Login scopes (handled by the API) include identity + Calendar events + Drive readonly.

---

## 5) Reverse proxy (nginx sketch)

Terminate TLS at nginx; proxy to loopback Node:

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;

  # ssl_certificate …;
  # ssl_certificate_key …;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Long Copilot / Ollama generations
    proxy_read_timeout 300s;
  }
}
```

Caddy equivalent: reverse_proxy to `127.0.0.1:8787` with automatic HTTPS.

---

## 6) Run the API (dev vs production)

**Foreground / smoke test:**

```bash
npm start
# or: npm run dev   # watch mode
```

**Health check (from the server or through HTTPS):**

```bash
curl -sS https://api.example.com/health
# expect: {"ok":true,"service":"waypoint-api","storage":"postgres"}
```

**systemd unit example** (`/etc/systemd/system/waypoint-api.service`):

```ini
[Unit]
Description=Waypoint API
After=network.target

[Service]
Type=simple
User=waypoint
WorkingDirectory=/opt/waypoint/BigRedHacksProjectBackend
Environment=NODE_ENV=production
ExecStart=/usr/bin/node --experimental-strip-types src/index.ts
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now waypoint-api
sudo systemctl status waypoint-api
```

After **any** code or `.env` change: restart the service (`systemctl restart waypoint-api`).

Admin console (if `ADMIN_PASSWORD` set): `https://api.example.com/admin`

---

## 7) Point the Mac app at this server

On a Mac with Xcode CLT + Rust + Node (builder machine, not end users):

```bash
git clone https://github.com/legitminh/BigRedHacksProject.git
cd BigRedHacksProject
npm install
cp src-tauri/secrets.example.toml src-tauri/secrets.toml
```

Edit `src-tauri/secrets.toml` to your **public** API origin:

```toml
waypoint_api_base = "https://api.example.com"
local_llm_base = "https://api.example.com/v1/coach"
local_llm_model = "qwen2.5:0.5b"
local_vision_model = "moondream"
coach_api_token = ""          # leave empty in production; users use Google JWT
presage_api_key = ""
```

Rules:

- Use **HTTPS** production URLs (same host as `PUBLIC_BASE_URL`).
- **Never** put `gemini_api_key`, `google_client_id`, or `google_client_secret` in `secrets.toml` (build fails if they are non-empty).
- Rebuild after changing the API URL — the base is compiled into the `.app`.

```bash
npm run app:build
open src-tauri/target/release/bundle/macos/Waypoint.app
```

Ship the `.app` / `.dmg` from `src-tauri/target/release/bundle/`. End users: open app → Sign in with Google → approve Calendar/Drive → use Copilot / Lock-in.

**Switching API hosts later:** change `waypoint_api_base` / `local_llm_base` in `secrets.toml` and run `npm run app:build` again (or distribute a new build).

---

## 8) Checklist

- [ ] `GET https://…/health` → `ok: true`, `storage: postgres` (or `file` for a lab box)
- [ ] Google redirect URIs match `PUBLIC_BASE_URL`
- [ ] Ollama has `qwen2.5:0.5b`, `moondream`, and `qwen2.5:7b`
- [ ] Mac `secrets.toml` points at the same HTTPS origin
- [ ] Fresh Mac build after setting the API URL
- [ ] Sign-in in browser returns to Waypoint; Copilot replies even if Gemini is rate-limited

---

## 9) Local laptop (optional)

For same-machine development:

```env
BIND_HOST=127.0.0.1
PUBLIC_BASE_URL=http://127.0.0.1:8787
```

Desktop `secrets.toml`:

```toml
waypoint_api_base = "http://127.0.0.1:8787"
local_llm_base = "http://127.0.0.1:8787/v1/coach"
```

Google redirect URIs: `http://127.0.0.1:8787/v1/auth/google/callback` (and calendar callback).
