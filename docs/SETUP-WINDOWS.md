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

## 5. Internet play — real domain, no certificate warnings

With a domain (e.g. `mba.mouftools.com`), players anywhere get a trusted
certificate and the LAN self-signed warning goes away entirely:

1. **DNS — automatic (recommended).** Create a Vercel API token
   (vercel.com → avatar → *Account Settings* → *Tokens* → Create, scope: the
   account that owns the domain), then write `server/data/dns.json`:
   ```json
   { "token": "YOUR_TOKEN", "domain": "mouftools.com", "name": "mba" }
   ```
   The server now keeps `mba.mouftools.com` pointed at your current public IP:
   it checks every 5 minutes, creates the record if it doesn't exist, and
   rewrites it whenever your home IP changes. Test with `npm run dns` in
   `server/` — it should print `mba.mouftools.com -> <your ip> (created)`.
   The file lives in the gitignored data dir; the token never leaves your
   machine.

   *Manual alternative:* Vercel dashboard → **Domains** → `mouftools.com` →
   **DNS Records** → Add: Type `A`, Name `mba`, Value = your public IP
   (whatismyip.com), TTL 60. You'll have to re-edit it whenever your home IP
   changes.
2. **Router** — forward **TCP 80 and 443** to this PC's LAN address.
3. **Run** — with the game server already running:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\start-public.ps1 -Domain mba.mouftools.com
   ```
   This installs Caddy (once), opens firewall ports, gets/renews Let's Encrypt
   certificates automatically, and proxies HTTPS+WebSocket to the local
   server. Players open `https://mba.mouftools.com` — LAN players can use the
   same URL if the router supports NAT loopback (most do); otherwise they keep
   using `https://<lan-ip>:8443`.

### No port forwarding? Tunnels

If you can't (or don't want to) forward router ports, an outbound tunnel from
the PC works instead — nothing inbound is ever opened:

- **Cloudflare quick tunnel** — zero setup, great for a session:
  `winget install Cloudflare.cloudflared`, then
  `cloudflared tunnel --url http://localhost:8484`. It prints a random
  `https://….trycloudflare.com` URL with a real certificate (so ROM play
  works). New URL every start.
- **Cloudflare named tunnel** — same idea but permanently at your own domain;
  requires the domain's DNS to be hosted on Cloudflare (free, but you'd move
  `mouftools.com`'s nameservers off Vercel).
- **Tailscale** — friends-only private network; every player installs
  Tailscale and joins your tailnet, no public exposure at all. Its *Funnel*
  feature can also expose the server publicly on a `*.ts.net` HTTPS URL.

The raw-TCP Lua port (8485) should stay LAN-only in all setups.

### Why the extra HTTPS everywhere?

Browsers only allow the threaded mGBA-WASM core (SharedArrayBuffer /
cross-origin isolation) in a **secure context**: `https://` anywhere, or
`http://localhost` on the host itself. Plain `http://<lan-ip>` can run demo
mode but never the real emulator — that's what the server's self-signed
:8443 listener (LAN) and this section (internet) are for.

### Search-engine indexing

The site ships `web/robots.txt` (allows the landing page, disallows the ROM
binary and the JSON API) and `web/sitemap.xml`, and `index.html` carries the
description / canonical / Open Graph tags crawlers read. That's everything
served automatically. To actually get listed on Google:

1. The public HTTPS setup above must be live (`https://mba.mouftools.com`) —
   crawlers can only index the site while your PC + server are running.
2. Verify ownership in [Google Search Console](https://search.google.com/search-console)
   (a DNS TXT record in Vercel, or the HTML-tag method), then **submit
   `https://mba.mouftools.com/sitemap.xml`**. Indexing then happens on
   Google's schedule (days to weeks).

Note: indexing makes the site publicly discoverable. This project serves a
copyrighted ROM for personal use — appearing in search results is a
different exposure level than a private link shared with friends. To pull it
back out of search later, change `web/robots.txt` to `Disallow: /` and
remove the sitemap submission.
