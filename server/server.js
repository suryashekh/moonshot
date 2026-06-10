/* ================================================================
   LUNAR RALLY — LAN race server
   ----------------------------------------------------------------
   * Serves the client (public/) over HTTP on port 3000.
   * Hosts WebSocket rooms (/ws). One process can host many rooms.
   * AUTHORITATIVE for: lobby, countdown, checkpoints/laps/ranks,
     item pickups & use, projectiles, mines, traps, EMP, asteroid
     impacts, damage, respawns, race results.
   * Clients simulate their own rover locally and stream pose at
     ~15 Hz; the server validates (speed/teleport clamps), resolves
     all hits, and broadcasts 15 Hz snapshots.
   Run:  node server/server.js   →  open http://<host-LAN-ip>:3000
   ================================================================ */
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const S = require('../shared/constants.js');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const PUB  = path.join(ROOT, 'public');

/* ---------------- static file server --------------------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json',
};
const httpServer = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/') url = '/index.html';
  let file;
  if (url === '/lib/three.min.js') {
    file = path.join(ROOT, 'node_modules', 'three', 'build', 'three.min.js');
  } else if (url === '/shared/constants.js') {
    file = path.join(ROOT, 'shared', 'constants.js');
  } else {
    file = path.join(PUB, path.normalize(url));
    if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- helpers -------------------------------------- */
const now = () => Date.now();
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
  return c;
}
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const a of ifs[k] || []) {
    if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
function send(ws, msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

/* ---------------- room ------------------------------------------ */
const GATES = S.gatePositions();
const rooms = new Map();           // code -> Room
let nextEntityId = 1;

class Room {
  constructor(code) {
    this.code = code;
    this.state = 'lobby';          // lobby | countdown | race | end
    this.players = new Map();      // id -> P
    this.hostId = null;
    this.seed = (Math.random() * 1e9) | 0;
    this.rng = S.mulberry32(this.seed);
    this.projectiles = [];
    this.mines = [];
    this.traps = [];
    this.asteroids = [];           // pending impacts
    this.crates = S.CRATES.map(c => ({ id: c.id, x: c.x, z: c.z, up: true, respawnAt: 0 }));
    this.raceStartTs = 0;
    this.nextAsteroidAt = 0;
    this.nextShowerAt = 0;
    this.nextHazardAt = 0;
    this.firstFinishTs = 0;
    this.lastSnap = 0;
    this.lastTick = now();
  }

  /* ----- lifecycle ----- */
  broadcast(msg, exceptId) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values())
      if (p.ws && p.id !== exceptId && p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  }

  lobbyInfo() {
    return {
      t: 'lobby',
      state: this.state,
      hostId: this.hostId,
      players: [...this.players.values()].map(p => ({
        id: p.id, name: p.name, color: p.color, connected: !!p.ws,
      })),
    };
  }

  addPlayer(ws, name) {
    const id = nextEntityId++;
    const color = S.PLAYER_COLORS[(id - 1) % S.PLAYER_COLORS.length];
    const startIdx = this.players.size;
    const p = {
      id, ws, name: String(name || 'PILOT').slice(0, 12).toUpperCase() || 'PILOT',
      color, token: crypto.randomBytes(8).toString('hex'),
      startIdx,
      // pose (client-reported, server-validated)
      x: 0, y: 0, z: 0, yaw: 0, vf: 0, flags: 0, lastStateTs: 0,
      // race
      lap: 1, nextGate: 0, gatesPassed: 0, lapStartTs: 0, bestLap: 0,
      finished: false, totalMs: 0, rank: 1, progress: 0,
      // combat
      hp: S.DMG.maxHp, item: null, useCooldownUntil: 0,
      shieldUntil: 0, empUntil: 0, boostUntil: 0, gstabUntil: 0, decoyUntil: 0,
      deadUntil: 0, invulnUntil: 0, lastRamAt: 0, lastOuchAt: 0,
      disconnectedAt: 0,
    };
    if (!this.hostId) this.hostId = id;
    this.players.set(id, p);
    return p;
  }

  removePlayer(p) {
    this.players.delete(p.id);
    if (this.hostId === p.id) {
      const first = this.players.values().next().value;
      this.hostId = first ? first.id : null;
      if (first) send(first.ws, { t: 'host' });
    }
    this.broadcast(this.lobbyInfo());
    if (this.players.size === 0) rooms.delete(this.code);
  }

  startRace() {
    this.state = 'countdown';
    this.projectiles.length = 0; this.mines.length = 0;
    this.traps.length = 0; this.asteroids.length = 0;
    for (const c of this.crates) { c.up = true; c.respawnAt = 0; }
    let i = 0;
    for (const p of this.players.values()) {
      p.lap = 1; p.nextGate = 0; p.gatesPassed = 0; p.bestLap = 0;
      p.finished = false; p.totalMs = 0; p.hp = S.DMG.maxHp; p.item = null;
      p.shieldUntil = p.empUntil = p.boostUntil = p.gstabUntil = p.decoyUntil = 0;
      p.deadUntil = 0; p.invulnUntil = 0; p.startIdx = i++;
    }
    this.firstFinishTs = 0;
    this.broadcast({ t: 'raceSetup', startGrid: [...this.players.values()].map(p => ({ id: p.id, slot: p.startIdx })) });
    // 3‑2‑1‑GO
    let n = 3;
    const step = () => {
      if (!rooms.has(this.code)) return;
      if (n > 0) {
        this.broadcast({ t: 'countdown', n });
        n--; setTimeout(step, 1000);
      } else {
        this.state = 'race';
        this.raceStartTs = now();
        const t0 = this.raceStartTs;
        for (const p of this.players.values()) p.lapStartTs = t0;
        this.nextAsteroidAt = t0 + 8000;
        this.nextShowerAt = 0;
        this.nextHazardAt = t0 + 20000;
        this.broadcast({ t: 'go', ts: t0 });
      }
    };
    setTimeout(step, 600);
  }

  backToLobby() {
    this.state = 'lobby';
    this.broadcast({ t: 'toLobby' });
    this.broadcast(this.lobbyInfo());
  }

  /* ----- leader lap (difficulty driver) ----- */
  leaderLap() {
    let L = 1;
    for (const p of this.players.values()) if (!p.finished) L = Math.max(L, p.lap);
    return Math.min(L, S.WORLD.laps);
  }

  /* ----- damage / death ----- */
  applyDamage(victim, dmg, kind, srcId, fx) {
    const t = now();
    if (victim.finished || victim.deadUntil > t || victim.invulnUntil > t) return false;
    const major = (kind !== 'emp' && kind !== 'ram' && kind !== 'rock');
    if (victim.shieldUntil > t && major) {
      victim.shieldUntil = 0;
      this.broadcast({ t: 'fx', kind: 'shieldBreak', id: victim.id });
      return false;
    }
    victim.hp = Math.max(0, victim.hp - dmg);
    this.broadcast({ t: 'damage', id: victim.id, hp: victim.hp, kind, src: srcId || 0, fx: fx || null });
    if (victim.hp <= 0) this.kill(victim, kind, srcId);
    return true;
  }

  kill(victim, kind, srcId) {
    const t = now();
    victim.deadUntil = t + S.COMBAT.respawnMs;
    const by = srcId ? this.players.get(srcId) : null;
    this.broadcast({
      t: 'kill', victim: victim.id, by: by ? by.id : 0, kind,
      respawnIn: S.COMBAT.respawnMs,
    });
    setTimeout(() => this.respawn(victim), S.COMBAT.respawnMs);
  }

  respawn(victim, instant) {
    if (!this.players.has(victim.id)) return;
    const t = now();
    // last gate passed = nextGate - 1 (wrap); place a bit before it on the ring
    const gi = ((victim.nextGate - 1) + S.GATE_COUNT) % S.GATE_COUNT;
    const g = GATES[gi];
    victim.hp = Math.max(victim.hp, 60);
    if (!instant) victim.hp = S.DMG.maxHp * 0.7 | 0;
    victim.deadUntil = 0;
    victim.invulnUntil = t + (instant ? 1200 : S.COMBAT.invulnMs);
    victim.x = g.x; victim.z = g.z; victim.y = 0; victim.yaw = g.heading;
    this.broadcast({
      t: 'respawn', id: victim.id, x: g.x, z: g.z, heading: g.heading,
      invulnMs: instant ? 1200 : S.COMBAT.invulnMs,
    });
  }

  /* ----- asteroids ----- */
  spawnAsteroid(opts) {
    const t = now();
    const o = opts || {};
    let x = o.x, z = o.z;
    if (x === undefined) {
      const a = this.rng() * S.TAU;
      const r = S.trackRadius(a) + (this.rng() * 2 - 1) * 28;
      x = Math.cos(a) * r; z = Math.sin(a) * r;
    }
    const lap = this.leaderLap();
    const warn = o.warnMs || (3200 - lap * 280);
    const ast = {
      id: nextEntityId++, x, z,
      impactTs: t + warn,
      big: !!o.big, dead: false,
    };
    this.asteroids.push(ast);
    this.broadcast({ t: 'astSpawn', id: ast.id, x, z, impactTs: ast.impactTs, big: ast.big });
  }

  resolveAsteroid(ast) {
    const hits = [];
    for (const p of this.players.values()) {
      if (p.finished || p.deadUntil > 0 && p.deadUntil > now()) continue;
      const d = Math.sqrt(dist2(p.x, p.z, ast.x, ast.z));
      if (d < S.DMG.asteroidDirectR) {
        hits.push({ id: p.id, dmg: S.DMG.asteroidDirect, d });
      } else if (d < S.DMG.asteroidShockR) {
        const k = 1 - (d - S.DMG.asteroidDirectR) / (S.DMG.asteroidShockR - S.DMG.asteroidDirectR);
        hits.push({ id: p.id, dmg: Math.round(S.DMG.asteroidNearMax * k), d });
      }
    }
    this.broadcast({ t: 'astBoom', id: ast.id, x: ast.x, z: ast.z, big: ast.big, hits: hits.map(h => h.id) });
    for (const h of hits) {
      const p = this.players.get(h.id);
      if (p) this.applyDamage(p, h.dmg, 'asteroid', 0, { kx: p.x - ast.x, kz: p.z - ast.z, mag: h.dmg / 8 });
    }
  }

  /* ----- items ----- */
  rankT(p) {
    const n = this.players.size;
    return n <= 1 ? 0 : (p.rank - 1) / (n - 1);
  }

  useItem(p) {
    const t = now();
    if (this.state !== 'race' || p.finished) return;
    if (!p.item || t < p.useCooldownUntil || p.deadUntil > t) return;
    const item = p.item;
    p.item = null;
    p.useCooldownUntil = t + S.COMBAT.useCooldownMs;
    this.broadcast({ t: 'itemUsed', id: p.id, item });

    switch (item) {
      case 'boost':
        p.boostUntil = t + S.COMBAT.boostMs;
        this.broadcast({ t: 'fx', kind: 'boost', id: p.id, until: p.boostUntil });
        break;
      case 'repair':
        p.hp = Math.min(S.DMG.maxHp, p.hp + S.COMBAT.repairAmount);
        this.broadcast({ t: 'fx', kind: 'repair', id: p.id, hp: p.hp });
        break;
      case 'shield':
        p.shieldUntil = t + S.COMBAT.shieldMs;
        this.broadcast({ t: 'fx', kind: 'shield', id: p.id, until: p.shieldUntil });
        break;
      case 'gstab':
        p.gstabUntil = t + S.COMBAT.gstabMs;
        this.broadcast({ t: 'fx', kind: 'gstab', id: p.id, until: p.gstabUntil });
        break;
      case 'decoy':
        p.decoyUntil = t + S.COMBAT.decoyMs;
        this.broadcast({ t: 'fx', kind: 'decoy', id: p.id, until: p.decoyUntil });
        break;
      case 'mine': {
        const m = {
          id: nextEntityId++, owner: p.id,
          x: p.x - Math.sin(p.yaw) * 3.2, z: p.z - Math.cos(p.yaw) * 3.2,
          armedAt: t + S.COMBAT.mineArmMs, dieAt: t + S.COMBAT.mineLifeMs,
        };
        this.mines.push(m);
        this.broadcast({ t: 'mine', id: m.id, owner: p.id, x: m.x, z: m.z });
        break;
      }
      case 'gtrap': {
        const tr = {
          id: nextEntityId++, owner: p.id,
          x: p.x - Math.sin(p.yaw) * 4.0, z: p.z - Math.cos(p.yaw) * 4.0,
          dieAt: t + S.COMBAT.trapLifeMs,
        };
        this.traps.push(tr);
        this.broadcast({ t: 'trap', id: tr.id, owner: p.id, x: tr.x, z: tr.z, r: S.COMBAT.trapR, dieAt: tr.dieAt });
        break;
      }
      case 'emp': {
        const victims = [];
        for (const q of this.players.values()) {
          if (q.id === p.id || q.finished) continue;
          if (dist2(p.x, p.z, q.x, q.z) < S.COMBAT.empR * S.COMBAT.empR) {
            if (q.shieldUntil > t) { q.shieldUntil = 0; this.broadcast({ t: 'fx', kind: 'shieldBreak', id: q.id }); continue; }
            q.empUntil = t + S.COMBAT.empImpairMs;
            victims.push(q.id);
            this.applyDamage(q, S.DMG.emp, 'emp', p.id);
          }
        }
        this.broadcast({ t: 'empBlast', id: p.id, x: p.x, z: p.z, r: S.COMBAT.empR, victims });
        break;
      }
      case 'srocket': {
        const r = {
          id: nextEntityId++, kind: 'srocket', owner: p.id,
          x: p.x + Math.sin(p.yaw) * 2.2, z: p.z + Math.cos(p.yaw) * 2.2,
          yaw: p.yaw, speed: S.COMBAT.srocketSpeed + Math.max(p.vf, 0),
          dieAt: t + S.COMBAT.srocketLifeMs, target: 0, decoyed: false,
        };
        this.projectiles.push(r);
        this.broadcast({ t: 'rocket', id: r.id, kind: 'srocket', owner: p.id, x: r.x, z: r.z, yaw: r.yaw, speed: r.speed });
        break;
      }
      case 'hrocket': {
        // target: nearest opponent AHEAD in race progress, else nearest
        let best = null, bestScore = Infinity;
        for (const q of this.players.values()) {
          if (q.id === p.id || q.finished || q.deadUntil > t) continue;
          const ahead = q.progress >= p.progress;
          const d = Math.sqrt(dist2(p.x, p.z, q.x, q.z));
          const score = d + (ahead ? 0 : 600);
          if (score < bestScore) { bestScore = score; best = q; }
        }
        const r = {
          id: nextEntityId++, kind: 'hrocket', owner: p.id,
          x: p.x + Math.sin(p.yaw) * 2.2, z: p.z + Math.cos(p.yaw) * 2.2,
          yaw: p.yaw, speed: S.COMBAT.hrocketSpeed,
          dieAt: t + S.COMBAT.hrocketLifeMs,
          target: best ? best.id : 0, decoyed: false, dx: 0, dz: 0,
        };
        this.projectiles.push(r);
        this.broadcast({ t: 'rocket', id: r.id, kind: 'hrocket', owner: p.id, x: r.x, z: r.z, yaw: r.yaw, speed: r.speed, target: r.target });
        if (best) send(best.ws, { t: 'lockOn', by: p.id });
        break;
      }
      case 'meteor': {
        // strike the area ahead of the best-ranked opponent
        let target = null;
        for (const q of this.players.values()) {
          if (q.id === p.id || q.finished) continue;
          if (!target || q.rank < target.rank) target = q;
        }
        const aim = target || p;
        const ax = aim.x + Math.sin(aim.yaw) * 55;
        const az = aim.z + Math.cos(aim.yaw) * 55;
        this.broadcast({ t: 'meteorWarn', by: p.id, x: ax, z: az });
        for (let i = 0; i < 4; i++) {
          const ang = this.rng() * S.TAU, rr = this.rng() * 22;
          this.spawnAsteroid({ x: ax + Math.cos(ang) * rr, z: az + Math.sin(ang) * rr, warnMs: 2600 + i * 320, big: i === 0 });
        }
        break;
      }
    }
  }

  /* ----- per-tick simulation (30 Hz) ----- */
  tick() {
    const t = now();
    const dt = Math.min((t - this.lastTick) / 1000, 0.1);
    this.lastTick = t;
    if (this.state !== 'race') return;

    /* projectiles */
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const r = this.projectiles[i];
      if (r.kind === 'hrocket' && r.target) {
        const q = this.players.get(r.target);
        let tx, tz;
        if (q && q.decoyUntil > t && !r.decoyed) {
          // decoy pull: chase a point dropped behind the target (one-time, 70 %)
          if (this.rng() < 0.7) {
            r.decoyed = true;
            r.dx = q.x - Math.sin(q.yaw) * 16;
            r.dz = q.z - Math.cos(q.yaw) * 16;
          }
        }
        if (r.decoyed) { tx = r.dx; tz = r.dz; }
        else if (q && q.deadUntil < t && !q.finished) { tx = q.x; tz = q.z; }
        if (tx !== undefined) {
          const want = Math.atan2(tx - r.x, tz - r.z);
          let d = want - r.yaw;
          while (d > Math.PI) d -= S.TAU;
          while (d < -Math.PI) d += S.TAU;
          r.yaw += clamp(d, -S.COMBAT.hrocketTurn * dt, S.COMBAT.hrocketTurn * dt);
        }
        if (r.decoyed && dist2(r.x, r.z, r.dx, r.dz) < 9) { this.boomRocket(r, null); this.projectiles.splice(i, 1); continue; }
      }
      r.x += Math.sin(r.yaw) * r.speed * dt;
      r.z += Math.cos(r.yaw) * r.speed * dt;

      // hit players
      const hitR = r.kind === 'hrocket' ? S.COMBAT.hrocketHitR : S.COMBAT.srocketHitR;
      let hit = null;
      for (const q of this.players.values()) {
        if (q.id === r.owner || q.finished || q.deadUntil > t || q.invulnUntil > t) continue;
        if (dist2(r.x, r.z, q.x, q.z) < hitR * hitR) { hit = q; break; }
      }
      // straight rockets can shoot down incoming asteroids
      if (!hit && r.kind === 'srocket') {
        for (const a of this.asteroids) {
          if (a.dead) continue;
          const frac = 1 - (a.impactTs - t) / 3200;
          if (frac > 0.55 && dist2(r.x, r.z, a.x, a.z) < 36) {
            a.dead = true;
            this.broadcast({ t: 'astKilled', id: a.id, by: r.owner });
            this.boomRocket(r, null);
            hit = 'ast';
            break;
          }
        }
        if (hit === 'ast') { this.projectiles.splice(i, 1); continue; }
      }
      if (hit) {
        this.boomRocket(r, hit);
        this.projectiles.splice(i, 1);
        continue;
      }
      const B = S.WORLD.terrainSize / 2 - 10;
      if (t > r.dieAt || Math.abs(r.x) > B || Math.abs(r.z) > B) {
        this.boomRocket(r, null);
        this.projectiles.splice(i, 1);
      }
    }

    /* mines */
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      if (t > m.dieAt) { this.broadcast({ t: 'mineGone', id: m.id }); this.mines.splice(i, 1); continue; }
      if (t < m.armedAt) continue;
      for (const q of this.players.values()) {
        if (q.finished || q.deadUntil > t || q.invulnUntil > t) continue;
        if (q.id === m.owner && t < m.armedAt + 2000) continue; // owner grace
        if (dist2(m.x, m.z, q.x, q.z) < S.COMBAT.mineTriggerR * S.COMBAT.mineTriggerR) {
          this.broadcast({ t: 'mineBoom', id: m.id, x: m.x, z: m.z });
          this.applyDamage(q, S.DMG.mine, 'mine', m.owner, { kx: q.x - m.x, kz: q.z - m.z, mag: 5, slip: 1500 });
          this.mines.splice(i, 1);
          break;
        }
      }
    }

    /* traps expiry */
    for (let i = this.traps.length - 1; i >= 0; i--) {
      if (t > this.traps[i].dieAt) { this.broadcast({ t: 'trapGone', id: this.traps[i].id }); this.traps.splice(i, 1); }
    }

    /* asteroids due */
    for (let i = this.asteroids.length - 1; i >= 0; i--) {
      const a = this.asteroids[i];
      if (a.dead) { this.asteroids.splice(i, 1); continue; }
      if (t >= a.impactTs) { this.resolveAsteroid(a); this.asteroids.splice(i, 1); }
    }

    /* asteroid scheduler (difficulty ramps with leader lap) */
    const lap = this.leaderLap();
    if (t >= this.nextAsteroidAt) {
      this.spawnAsteroid();
      const base = lap === 1 ? [6500, 10000] : lap === 2 ? [4000, 6500] : [2500, 4500];
      this.nextAsteroidAt = t + base[0] + this.rng() * (base[1] - base[0]);
      if (lap === 2 && this.rng() < 0.3) this.spawnAsteroid();
    }
    if (lap >= 3) {
      if (!this.nextShowerAt) this.nextShowerAt = t + 12000;
      if (t >= this.nextShowerAt) {
        this.broadcast({ t: 'shower' });
        const n = 5 + (this.rng() * 4) | 0;
        for (let i = 0; i < n; i++) this.spawnAsteroid({ warnMs: 2400 + this.rng() * 1800 });
        this.nextShowerAt = t + 20000 + this.rng() * 10000;
      }
    }

    /* hazard events from lap 2 */
    if (lap >= 2 && t >= this.nextHazardAt) {
      const kinds = ['flare', 'quake', 'storm'];
      const k = kinds[(this.rng() * kinds.length) | 0];
      const dur = k === 'flare' ? 6000 : k === 'quake' ? 5000 : 8000;
      this.broadcast({ t: 'hazard', kind: k, ms: dur });
      this.nextHazardAt = t + 18000 + this.rng() * 14000;
    }

    /* crates: pickups + respawn */
    for (const c of this.crates) {
      if (!c.up) {
        if (t >= c.respawnAt) { c.up = true; this.broadcast({ t: 'crateUp', id: c.id }); }
        continue;
      }
      for (const p of this.players.values()) {
        if (p.item || p.finished || p.deadUntil > t) continue;
        if (dist2(c.x, c.z, p.x, p.z) < S.CRATE_PICK_R * S.CRATE_PICK_R) {
          c.up = false; c.respawnAt = t + S.CRATE_RESPAWN_MS;
          p.item = S.rollItem(this.rankT(p), this.rng);
          this.broadcast({ t: 'crateTaken', id: c.id, by: p.id, item: p.item });
          break;
        }
      }
    }

    /* checkpoints / laps / progress / ranks */
    for (const p of this.players.values()) {
      if (p.finished || p.deadUntil > t) continue;
      const g = GATES[p.nextGate];
      const gr = S.gateRadius(p.lap);
      if (dist2(p.x, p.z, g.x, g.z) < gr * gr) {
        p.nextGate = (p.nextGate + 1) % S.GATE_COUNT;
        p.gatesPassed++;
        this.broadcast({ t: 'gate', id: p.id, nextGate: p.nextGate, lap: p.lap });
        if (p.nextGate === 0) {              // crossed start: lap complete
          const lapMs = t - p.lapStartTs;
          p.lapStartTs = t;
          if (!p.bestLap || lapMs < p.bestLap) p.bestLap = lapMs;
          p.lap++;
          if (p.lap > S.WORLD.laps) {
            p.finished = true;
            p.totalMs = t - this.raceStartTs;
            this.broadcast({ t: 'finish', id: p.id, totalMs: p.totalMs, bestLap: p.bestLap });
            if (!this.firstFinishTs) this.firstFinishTs = t;
          } else {
            this.broadcast({ t: 'lap', id: p.id, lap: p.lap, lapMs, bestLap: p.bestLap });
          }
        }
      }
      // continuous progress metric for ranking: gates passed + fraction toward next gate
      const dNext = Math.sqrt(dist2(p.x, p.z, GATES[p.nextGate].x, GATES[p.nextGate].z));
      p.progress = p.gatesPassed + clamp(1 - dNext / 180, 0, 0.98);
    }

    /* ranks */
    const order = [...this.players.values()].sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.totalMs - b.totalMs;
      return b.progress - a.progress;
    });
    order.forEach((p, i) => { p.rank = i + 1; });

    /* end conditions */
    const unfinished = order.filter(p => !p.finished);
    const allDone = unfinished.length === 0;
    const timedOut = this.firstFinishTs && (t - this.firstFinishTs > S.NET.finishGraceMs);
    if (allDone || timedOut) {
      this.state = 'end';
      this.broadcast({
        t: 'raceEnd',
        results: order.map(p => ({
          id: p.id, name: p.name, color: p.color, finished: p.finished,
          totalMs: p.totalMs, bestLap: p.bestLap, rank: p.rank, lap: p.lap,
        })),
      });
    }

    /* snapshots @ 15 Hz */
    if (t - this.lastSnap >= 1000 / S.NET.snapHz) {
      this.lastSnap = t;
      const ps = [];
      for (const p of this.players.values()) {
        let f = p.flags & (S.F.DRIFT | S.F.AIR | S.F.LIGHTS);
        if (p.deadUntil > t) f |= S.F.DEAD;
        if (p.shieldUntil > t) f |= S.F.SHIELD;
        if (p.empUntil > t) f |= S.F.EMP;
        if (p.invulnUntil > t) f |= S.F.INVULN;
        if (p.boostUntil > t) f |= S.F.BOOST;
        if (p.finished) f |= S.F.FINISHED;
        ps.push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2),
          +p.yaw.toFixed(3), +p.vf.toFixed(2), f, p.hp, p.lap, p.nextGate, p.rank]);
      }
      const pr = this.projectiles.map(r => [r.id, +r.x.toFixed(1), +r.z.toFixed(1), +r.yaw.toFixed(2)]);
      this.broadcast({ t: 'snap', ts: t, ps, pr });
    }
  }

  boomRocket(r, victim) {
    const x = victim ? victim.x : r.x;
    const z = victim ? victim.z : r.z;
    this.broadcast({ t: 'rocketBoom', id: r.id, x, z, victim: victim ? victim.id : 0 });
    if (victim) {
      const dmg = r.kind === 'hrocket' ? S.DMG.hrocket : S.DMG.srocket;
      this.applyDamage(victim, dmg, r.kind, r.owner, {
        kx: victim.x - (r.x - Math.sin(r.yaw)), kz: victim.z - (r.z - Math.cos(r.yaw)),
        mag: 6, spin: 1,
      });
    }
  }
}

/* ---------------- websocket layer ------------------------------- */
const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

wss.on('connection', (ws) => {
  let room = null, player = null;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const t = now();

    switch (m.t) {
      case 'create': {
        let code = makeCode();
        while (rooms.has(code)) code = makeCode();
        room = new Room(code);
        rooms.set(code, room);
        player = room.addPlayer(ws, m.name);
        send(ws, joinPayload(room, player));
        room.broadcast(room.lobbyInfo());
        break;
      }
      case 'join': {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) return send(ws, { t: 'err', msg: 'Room not found. Check the code.' });
        if (r.state !== 'lobby') return send(ws, { t: 'err', msg: 'Race already in progress.' });
        if (r.players.size >= 8) return send(ws, { t: 'err', msg: 'Room is full (8 max).' });
        room = r;
        player = room.addPlayer(ws, m.name);
        send(ws, joinPayload(room, player));
        room.broadcast(room.lobbyInfo());
        break;
      }
      case 'rejoin': {
        for (const r of rooms.values()) {
          for (const p of r.players.values()) {
            if (p.token === m.token) {
              room = r; player = p;
              if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {}
              p.ws = ws; p.disconnectedAt = 0;
              send(ws, joinPayload(room, player, true));
              room.broadcast(room.lobbyInfo());
              return;
            }
          }
        }
        send(ws, { t: 'err', msg: 'Session expired — join again.' });
        break;
      }
      case 'start': {
        if (!room || !player || player.id !== room.hostId) return;
        if (room.state !== 'lobby') return;
        if (room.players.size < 2 && !m.solo) return send(ws, { t: 'err', msg: 'Need at least 2 pilots (or Solo Test).' });
        room.startRace();
        break;
      }
      case 'toLobby': {
        if (room && player && player.id === room.hostId && room.state === 'end') room.backToLobby();
        break;
      }
      case 'state': {
        if (!room || !player || player.deadUntil > t) return;
        // light validation: clamp teleports & speeds
        const nx = +m.p[0], ny = +m.p[1], nz = +m.p[2];
        if (!isFinite(nx) || !isFinite(ny) || !isFinite(nz)) return;
        if (player.lastStateTs) {
          const dts = Math.max((t - player.lastStateTs) / 1000, 0.02);
          const d = Math.sqrt(dist2(nx, nz, player.x, player.z));
          if (d / dts > 60) return;  // > 60 m/s sustained = reject
        }
        player.lastStateTs = t;
        player.x = nx; player.y = ny; player.z = nz;
        player.yaw = +m.yaw || 0;
        player.vf = clamp(+m.vf || 0, -20, 40);
        player.flags = (m.f | 0) & (S.F.DRIFT | S.F.AIR | S.F.LIGHTS);
        break;
      }
      case 'use': if (room && player) room.useItem(player); break;
      case 'ouch': {
        // client-reported environmental damage, clamped + rate-limited
        if (!room || !player || room.state !== 'race') return;
        if (t - player.lastOuchAt < 450) return;
        player.lastOuchAt = t;
        const kind = m.kind === 'landing' ? 'landing' : 'rock';
        const cap = kind === 'landing' ? S.DMG.landingMax : S.DMG.rockMax;
        const dmg = clamp(Math.round(+m.mag || 0), 1, cap);
        room.applyDamage(player, dmg, kind, 0);
        break;
      }
      case 'ram': {
        if (!room || !player || room.state !== 'race') return;
        if (t - player.lastRamAt < 900) return;
        const q = room.players.get(m.target | 0);
        if (!q || q.id === player.id) return;
        if (dist2(player.x, player.z, q.x, q.z) > 36) return; // must actually be close
        player.lastRamAt = t;
        const boosted = player.boostUntil > t;
        room.applyDamage(q, boosted ? S.DMG.ram * 1.6 : S.DMG.ram, 'ram', player.id, {
          kx: q.x - player.x, kz: q.z - player.z, mag: boosted ? 5 : 3, slip: 900,
        });
        break;
      }
      case 'reqRespawn': {
        if (!room || !player || room.state !== 'race' || player.finished) return;
        if (player.deadUntil > t) return;
        room.respawn(player, true);
        break;
      }
      case 'ping': send(ws, { t: 'pong', cts: m.cts, sts: t }); break;
    }
  });

  ws.on('close', () => {
    if (!room || !player) return;
    player.ws = null;
    player.disconnectedAt = now();
    if (room.state === 'lobby') {
      room.removePlayer(player);
    } else {
      room.broadcast(room.lobbyInfo());
      const r = room, p = player;
      setTimeout(() => {
        if (rooms.has(r.code) && r.players.get(p.id) === p && !p.ws) r.removePlayer(p);
      }, S.NET.reconnectGraceMs);
    }
  });
});

function joinPayload(room, p, rejoined) {
  return {
    t: 'joined', code: room.code, id: p.id, token: p.token, color: p.color,
    hostId: room.hostId, state: room.state, rejoined: !!rejoined,
    serverNow: now(),
    urls: lanIPs().map(ip => `http://${ip}:${PORT}`),
    crates: room.crates.map(c => ({ id: c.id, up: c.up })),
  };
}

/* ---------------- main loop ------------------------------------- */
setInterval(() => { for (const r of rooms.values()) r.tick(); }, 1000 / 30);

httpServer.listen(PORT, () => {
  const ips = lanIPs();
  console.log('──────────────────────────────────────────────');
  console.log('  LUNAR RALLY server running');
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  LAN:     http://${ip}:${PORT}   ← share this`);
  console.log('──────────────────────────────────────────────');
});
