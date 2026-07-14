# Host setup — Windows 11

> **Shortcut:** `setup-windows.bat` in the repo root does everything on this
> page in one run (elevates itself, installs Node via winget if missing,
> installs dependencies, runs the server tests, optionally installs WSL2 and
> builds the ROM, opens the firewall, starts the server). The sections below
> are the manual equivalent and the reference for troubleshooting.

The host machine runs the server (always) and builds the ROM (once per change).
Players only need a browser — or desktop mGBA for the Lua path.

## 1. Run the server

1. Install [Node.js LTS](https://nodejs.org) (≥ 20; 22 recommended).
2. ```powershell
   cd server
   npm install
   npm test     # should be green
   npm start    # HTTP+WS on :8484, TCP bridge on :8485
   ```
   Or use `scripts\start-server.ps1`.
3. Allow it through the firewall (first run usually prompts; otherwise):
   ```powershell
   New-NetFirewallRule -DisplayName "MultiBoyAdvance" -Direction Inbound -Protocol TCP -LocalPort 8484,8485 -Action Allow
   ```
4. Find your LAN address: `ipconfig` → IPv4. Players browse to
   `http://<that-ip>:8484`.

## 2. Build the netcode ROM (WSL2)

ROM builds on Windows should use WSL2 (per pokeemerald guidance; MSYS2 is ~20×
slower).

```powershell
wsl --install -d Ubuntu   # once, then reboot if prompted
```

Inside Ubuntu:

```bash
sudo apt update
sudo apt install -y build-essential git libpng-dev gcc-arm-none-eabi binutils-arm-none-eabi
cd /mnt/c/path/to/MultiBoyAdvance/rom
./setup.sh          # clones pret/pokeemerald, applies the overlay, builds
```

Output: `rom/pokeemerald/pokeemerald.gba` (also copied to `rom/build/mba.gba`).
See [`rom/README.md`](../rom/README.md) for integration details and
troubleshooting.

> Legal: the decompilation reproduces Nintendo's game. Build and play only for
> personal use with a game you own. Never commit or distribute the ROM.

## 3. Play — browser path

1. Open `http://<host-ip>:8484`, pick a name.
2. Load the built `.gba` file (each player selects the same ROM build).
3. The status chip shows `mailbox: found` once the netcode ROM is running, and
   ghosts appear when a second player is on your map.

No ROM handy? Click **Demo mode** — a simulated overworld that exercises the
full multiplayer stack (useful to verify networking before ROM work).

## 4. Play — desktop mGBA path (LAN parties)

1. Install mGBA ≥ 0.11 dev build (scripting with sockets).
2. `Tools → Scripting… → Load script` → `rom/lua/mba-bridge.lua`.
   Set the server first via environment or edit the CONFIG block
   (`HOST`, `PORT=8485`, `NAME`).
3. Load the netcode ROM. The script log should show `connected` and
   `mailbox found @ 0x02xxxxxx`.

## 5. Internet play (Phase 5)

Preferred: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(`cloudflared tunnel --url http://localhost:8484`) — gives HTTPS (satisfies
COOP/COEP + secure WebSocket) without router changes. Alternative: port-forward
8484/8485 and front with a TLS proxy (Caddy is the easiest:
`caddy reverse-proxy --from your.domain --to localhost:8484`). The raw-TCP Lua
port should stay LAN-only unless you trust the network; WSS is browser-only.
