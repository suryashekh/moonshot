# LUNAR RALLY — Multiplayer LAN Lunar Rover Combat Racing

Three.js lunar rover simulator upgraded into a server-authoritative multiplayer racing survival game for 2–6 players on the same Wi-Fi network. Race 3 laps through 10 glowing checkpoint gates while dodging falling asteroids, hazard events, and each other's rockets, mines, EMPs, and traps.

## Quick Start

```bash
npm install        # installs ws (server) + three@0.128.0 (served to clients)
node server/server.js
```

The server prints LAN URLs on boot, e.g.:

```
LUNAR RALLY server on:
  http://192.168.1.42:3000   <- share this on your Wi-Fi
```

1. **Host**: open the URL in a browser, enter a pilot name, click **HOST GAME**. A 4-character room code appears.
2. **Others**: open the *same URL* on any device on the same Wi-Fi, enter the room code, click **JOIN**.
3. Host clicks **START RACE** (needs ≥2 players, or **SOLO TEST** to drive alone).

Port defaults to `3000`; override with `PORT=8080 node server/server.js`.

## Controls

| Input | Action |
|---|---|
| W / ↑ | Accelerate |
| S / ↓ | Brake / reverse |
| A / D or ← / → | Steer |
| Space | Handbrake drift |
| **Shift** | Fire selected weapon |
| **F** | Fire pulse blaster (6 shots, then recharge gap) |
| **Q / mouse wheel** | Swap selected weapon slot |
| **1–5** | Select weapon slot directly |
| Tab (hold) | Scoreboard |
| R | Respawn at last checkpoint |
| L | Headlights |

Touch controls (steer / throttle / brake / drift / item) appear automatically on mobile.

## Gameplay

- **Race**: 3 laps × 10 gates on a winding ring track. Gate radius tightens each lap. Cyan = your next gate, amber = others.
- **Asteroids**: most rocks *hunt a racer* — the server leads your velocity to the impact point, with a little scatter so a hard swerve saves you. Warning circles (yellow → red) mark impacts; a rock locked on YOU pulses red immediately and triggers a "⚠ ASTEROID LOCK" alert. Direct hit = destroyed → respawn at your last gate; near miss = knockback + damage. Frequency ramps with the leader's lap; lap 3 brings meteor showers and reduced visibility.
- **Car contact**: rovers collide for real — push, bounce, spin. Hard contact deals ram damage; do it while boosting for a heavier shove.
- **Pulse blaster**: everyone carries one (F / ⌖ on mobile). 6-shot magazine, then a forced 3.5 s recharge gap — ammo pips live in the HUD. Bolts chip opponents (shields soak them) and are the bread-and-butter way to kill aliens.
- **Aliens**: saucers materialize near racers, chase the nearest rover and zap it. Shoot one down (blaster or any rocket) for a bounty item. They show as green blips on the minimap.
- **Map + standings**: the minimap (top right) shows the track, gates, crates' players, aliens and incoming asteroids; a live standings panel below it shows everyone's rank and lap at all times.
- **Hazards**: solar flares (HUD glitch + whiteout), moonquakes (steering noise + shake), dust storms (fog), slip/rough zones, low-gravity jump pads.
- **Damage**: rocks, hard landings, weapons, asteroids. Below 50 HP your top speed drops. At 0 HP you respawn at your last gate after 3.5 s with 3 s of invulnerability.
- **Items** — hoard up to **5 at once** (crates respawn ~7 s; drop rates are rank-weighted — leaders get defensive/common items, trailing players get stronger ones). Shift fires the highlighted slot; Q / wheel / 1–5 to swap. Landing a hit pops a damage marker; destroying someone scores a TAKEDOWN (streaks tracked):
  - *Common*: Speed Boost, Repair, Shield
  - *Uncommon*: Straight Rocket, **Tri-Rocket** (3-shot fan), Lunar Mine, Gravity Trap
  - *Rare*: Homing Rocket (with lock-on warning), EMP Pulse (also **steals an item** from a victim), Decoy Flare, **Warp Ahead** (swap position *and race progress* with the racer one rank up)
  - *Legendary*: Meteor Strike (6 rocks ahead of the best opponent), **Grav Wave** — a universal power: gravity flips low or heavy *for every player* for 11 s
- **Ramming**: any hard contact shoves + damages; do it while boosting for a much bigger hit.

## Architecture

```
server/server.js      Node + ws. Rooms, 30 Hz authoritative tick, hit/damage/
                      lap validation, item rolls, asteroid scheduler, 15 Hz snapshots.
shared/constants.js   Deterministic world: seeded terrain params, track radius fn,
                      gate/crate/zone layout, damage & combat tuning. Used by both ends.
public/js/*.js        Modular client: scene, terrain, dust, rover physics, remote
                      interpolation (render at serverTime − 120 ms), race, asteroids,
                      power-ups, combat, hazards, HUD, network, main loop.
test/smoke.js         Headless 2-client race test (rooms, gates, laps, damage).
test/itemtest.js      Headless crate → use → broadcast pipeline test.
```

Clients simulate their own rover physics and stream pose at 15 Hz; the server validates (teleport/speed clamps), resolves all combat and race state, and broadcasts snapshots. Remote rovers are interpolated with ~120 ms buffer. Reconnect within 30 s restores your slot via a session token.

Terrain is generated from a fixed seed, so every client and the server compute identical gate, crate, and hazard-zone placement with zero geometry sync.

## Tests

```bash
node server/server.js &      # in one shell
node test/smoke.js           # 2 bots race: gates, laps, rock damage, asteroids
node test/itemtest.js        # crate pickup → Shift-use → weapon broadcast
node test/multitest.js       # multi-slot inventory, slot use, targeted asteroids
```
