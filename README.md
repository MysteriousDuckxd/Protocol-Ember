# PROTOCOL: EMBER — Online Server

This folder is everything you need to run public multiplayer servers for the game.
The server has **no dependencies** – it's plain Node.js. It also hosts the game itself,
so players just open your server's web address to play.

```
protocol-ember-server/
├── server.js          ← the game server (rooms, rules, public server list)
├── package.json
└── public/
    └── index.html     ← the game (players load it from your server)
```

---

## Put it online for free (Render) — about 10 minutes

### 1. Upload the files to GitHub
1. Make a free account at **github.com** (skip if you have one).
2. Click **+ → New repository**. Name it `protocol-ember-server`, keep it **Public**, click **Create repository**.
3. On the new repo page click **uploading an existing file**.
4. Drag in **everything inside this folder**: `server.js`, `package.json`, `README.md` and the whole `public` folder.
5. Click **Commit changes**.

### 2. Deploy on Render
1. Go to **render.com** and sign up with your GitHub account.
2. Click **New + → Web Service** and pick your `protocol-ember-server` repository.
3. Fill in:
   | Setting | Value |
   |---|---|
   | Runtime / Language | **Node** |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Instance Type | **Free** |
4. Click **Create Web Service** and wait until the log says
   `PROTOCOL: EMBER server running on port …` (1–3 minutes).

### 3. Play
1. Render shows your address at the top, e.g. `https://protocol-ember-server.onrender.com`.
2. Open it in Chrome or Edge → **MULTIPLAYER (ONLINE)**. The address is filled in automatically → **CONNECT**.
3. Pick a server from the list and press **JOIN**, or **Create a server**.
4. Send the address to your friends — they open the same link and join you.

> **Free plan note:** Render puts a free server to sleep after ~15 minutes with nobody on it.
> The next visitor waits about 50 seconds while it wakes up — just refresh / press CONNECT again.

---

## What you get

* **Public server list** – three servers that are always online
  (Dustline Bomb Defusal, Warehouse Team Deathmatch, Harbor Nights Bomb Defusal),
  plus any servers players create.
* **Create a server** – name, mode, map, time of day, 4–12 players, bots on/off, match length.
  Player-made servers disappear 30 seconds after the last person leaves.
* **Modes**
  * **Bomb Defusal** – Terrorists vs Soldiers, 15-second buy phase, money, plant/defuse, first to N rounds.
  * **Team Deathmatch** – respawn after 3s, $16,000 every life, 10-second buy window, first team to N kills.
* **Bots fill empty slots** (if enabled). One player's game (the "host") runs the bots; if they leave,
  another player takes over automatically.
* Your **name and outfit** from PROFILE are shown to other players. In-game **chat** with Enter.
* Switch team from the pause menu (Esc).

---

## Updating the game later
Replace `public/index.html` in your GitHub repo (open it → ✏️ / **Add file → Upload files**) and
commit. Render redeploys automatically in a minute or two.

## Run it on your own computer instead
1. Install Node.js 18+ from **nodejs.org**.
2. In this folder run: `node server.js`
3. Open **http://localhost:8080** – friends on the same Wi-Fi open `http://YOUR-PC-IP:8080`
   (find your IP with `ipconfig` on Windows / `ifconfig` on Mac).
   For friends over the internet you'd need port forwarding – the free Render option is easier.

## Other free hosts
Anything that runs a Node web service with WebSockets works (Railway, Fly.io, Koyeb…).
Start command `node server.js`; the server reads the `PORT` environment variable automatically.

## Good to know
* The claude.ai preview can't connect to servers – always play online through your server's address
  (or the downloaded HTML file, entering your server address on the Multiplayer screen).
* Hits are reported by the shooter's game and sanity-checked by the server (damage caps, rate limits,
  distance, teams). It's fine for playing with friends, but it isn't competitive-grade anti-cheat.
* Limits: 30 servers at once, up to 12 players each.
