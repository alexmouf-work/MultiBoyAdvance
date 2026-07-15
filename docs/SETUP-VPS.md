# Hosting on a VPS (Oracle Cloud Always Free walkthrough)

The server runs 24/7 on a cloud box; your PC's only remaining job is building
ROMs and pushing them up with one script. These steps are written for Oracle's
Always Free tier but the scripts are provider-agnostic — any fresh Ubuntu box
(Hetzner, DigitalOcean, …) works with the same two commands.

## 0. Money honesty (Oracle specifics)

- **There is no hard £0 spend cap on Oracle PAYG.** *Budgets* only send email
  alerts. You stay at £0 by only creating **Always Free shapes** (below stays
  inside them). Set a £1 budget alert as a tripwire: *Billing → Budgets*.
- Since **June 15, 2026** the free ARM allowance is **2 OCPUs + 12 GB RAM**
  total (halved from 4/24). Plenty for this project plus several more.
- Two idle risks to know: free-tier instances idling under ~20% CPU for a week
  can be reclaimed (PAYG accounts are exempt — one reason your PAYG plan is
  right), and fully unused *accounts* can be closed after long inactivity.

## 1. Create the instance

1. Sign up / upgrade to PAYG at cloud.oracle.com. Pick a **home region near
   you** (e.g. Frankfurt) — it can't be changed later and games feel the latency.
2. *Compute → Instances → Create instance*:
   - Image: **Ubuntu 24.04** (aarch64).
   - Shape: **VM.Standard.A1.Flex**, **2 OCPU / 12 GB** (the Always Free max).
   - Networking: create the default VCN; **assign a public IPv4**.
   - SSH keys: paste your public key (`ssh-keygen -t ed25519` in PowerShell,
     then paste the contents of `~\.ssh\id_ed25519.pub`).
   - If creation fails with "out of capacity": retry later, try another
     availability domain, or temporarily pick 1 OCPU/6 GB.
3. **Make the IP static**: *Networking → Reserved public IPs → Reserve*, then
   on the instance's attached VNIC edit the IPv4 to use the reserved IP.
   (Default "ephemeral" IPs change if the instance is ever stopped.)

## 2. Open web ports in the cloud firewall

*Networking → Virtual cloud networks → your VCN → Security Lists → Default*:
add two **ingress** rules, source `0.0.0.0/0`, protocol TCP, destination ports
**80** and **443**. (Port 8485, the desktop-mGBA bridge, stays closed — it has
no authentication and shouldn't face the internet.)

## 3. Provision the box (one command)

```bash
ssh ubuntu@<instance-ip>
curl -fsSL https://raw.githubusercontent.com/alexmouf-work/MultiBoyAdvance/main/deploy/setup-vps.sh | sudo bash -s -- mba.mouftools.com
```

Installs Node 22 + Caddy, opens the OS-level firewall (Oracle images ship a
default-deny iptables on top of the cloud one), creates the `mba` service
user + systemd unit, and writes a Caddyfile that gets/renews real Let's
Encrypt certificates for the domain automatically.

## 4. Point the domain at the box

Vercel dashboard → Domains → `mouftools.com` → DNS records: set the `mba`
**A record** to the reserved IP. One time only — it's static, so the dynamic
DNS updater isn't needed for the VPS. (Keep dns.json off the box.)

## 5. Deploy from your PC

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy-mba.ps1 -HostAddr <instance-ip>
```

Ships `server/`, `web/` (vendored emulator included), and your current
`rom\build\mba.gba`; installs server deps on the box; restarts the service.
Re-run it after every ROM rebuild — players get the new build on their next
join. World state (`server/data`) on the box is never overwritten.

Players everywhere: **https://mba.mouftools.com** — real certificate, no
warnings, iPhones/iPads welcome.

## 6. Adding your other projects to the same box

Each project = one systemd unit + one Caddyfile block:

```
project2.mouftools.com {
    reverse_proxy 127.0.0.1:3000
}
```

Add the `project2` A record at Vercel to the same IP, `sudo systemctl reload
caddy`, done — certificates included. The MBA pattern
(`/etc/systemd/system/mba.service`) is the template to copy.

## Troubleshooting

- `journalctl -u mba -n 50` — server logs; `systemctl status caddy` — proxy.
- https not issuing? DNS must already resolve to the box and ports 80/443 must
  be open in BOTH the Security List and iptables (`sudo iptables -L INPUT -n`).
- Join button disabled? The box has no ROM: re-run the deploy script from the
  PC after building one.
