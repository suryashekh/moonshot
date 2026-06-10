/* ================================================================
   SHARED CONSTANTS — loaded by BOTH the Node server (require) and
   the browser (plain <script>). Everything here must be pure data
   or pure functions: no THREE, no DOM, no net.
   The race track layout is deterministic so server and every
   client agree on gate / crate / zone positions without ever
   exchanging geometry.
   ================================================================ */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.SHARED = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const TAU = Math.PI * 2;

  /* ---------- world ------------------------------------------- */
  const WORLD = {
    terrainSize: 700,
    gravity: 1.62,
    laps: 3,
  };

  /* ---------- track ring --------------------------------------
     Radius of the racing line as a function of angle. Pure math:
     identical on server (gate validation) and clients (meshes). */
  function trackRadius(a) {
    return 245
      + 38 * Math.sin(a * 2.0 + 1.30)
      + 22 * Math.sin(a * 3.7 + 4.05)
      + 10 * Math.sin(a * 6.3 + 0.70);
  }

  const GATE_COUNT = 10;
  function gatePositions() {
    const out = [];
    for (let i = 0; i < GATE_COUNT; i++) {
      const a = (i / GATE_COUNT) * TAU;
      const r = trackRadius(a);
      // direction of travel = tangent (counter-clockwise, increasing a)
      out.push({
        i, a,
        x: Math.cos(a) * r,
        z: Math.sin(a) * r,
        // tangent heading for gate orientation (atan2(dx,dz) convention used by the sim)
        heading: Math.atan2(
          -Math.sin(a) * r, /* dx/da approx */
          Math.cos(a) * r   /* dz/da approx */
        ),
      });
    }
    return out;
  }

  // Gate pass radius tightens per lap (lap index 0-based, clamped)
  const GATE_RADIUS = [18, 14.5, 11.5];
  function gateRadius(lap) {
    return GATE_RADIUS[Math.min(Math.max(lap - 1, 0), GATE_RADIUS.length - 1)];
  }

  /* ---------- weapon / power-up crates ------------------------ */
  const CRATES = (function () {
    const out = [];
    let id = 0;
    for (let i = 0; i < GATE_COUNT; i++) {
      // between gate i and i+1: one or two pods
      const a1 = ((i + 0.45) / GATE_COUNT) * TAU;
      out.push({ id: id++, x: Math.cos(a1) * (trackRadius(a1) + (i % 2 ? 9 : -9)), z: Math.sin(a1) * (trackRadius(a1) + (i % 2 ? 9 : -9)) });
      if (i % 3 === 0) {
        const a2 = ((i + 0.72) / GATE_COUNT) * TAU;
        out.push({ id: id++, x: Math.cos(a2) * (trackRadius(a2) - 12), z: Math.sin(a2) * (trackRadius(a2) + 12) });
      }
    }
    return out;
  })();
  const CRATE_RESPAWN_MS = 7000;
  const CRATE_PICK_R = 4.0;
  const MAX_ITEMS = 5;            // inventory slots per rover

  /* ---------- items -------------------------------------------
     tier: 0 common, 1 uncommon, 2 rare, 3 legendary             */
  const ITEMS = {
    boost:   { name: 'BOOST',        tier: 0, icon: '»»' },
    repair:  { name: 'REPAIR',       tier: 0, icon: '✚'  },
    shield:  { name: 'SHIELD',       tier: 0, icon: '◉'  },
    srocket: { name: 'ROCKET',       tier: 1, icon: '➤'  },
    tri:     { name: 'TRI-ROCKET',   tier: 1, icon: '⋔'  },
    mine:    { name: 'LUNAR MINE',   tier: 1, icon: '✱'  },
    gtrap:   { name: 'GRAV TRAP',    tier: 1, icon: '◌'  },
    gstab:   { name: 'GRAV STAB',    tier: 1, icon: '▼'  },
    hrocket: { name: 'HOMING RKT',   tier: 2, icon: '➶'  },
    emp:     { name: 'EMP PULSE',    tier: 2, icon: '⌁'  },
    decoy:   { name: 'DECOY FLARE',  tier: 2, icon: '✦'  },
    warp:    { name: 'WARP AHEAD',   tier: 2, icon: '⇋'  },
    meteor:  { name: 'METEOR STRIKE',tier: 3, icon: '☄'  },
    gravity: { name: 'GRAV WAVE',    tier: 3, icon: '∿'  },
  };

  /* Rank-aware loot table. t = 0 leader … 1 last place.
     Leaders draw mostly defensive/common; tail draws offense.   */
  function rollItem(t, rnd) {
    const w = [
      ['boost',   2.2 + t * 1.2],
      ['repair',  2.0],
      ['shield',  2.2 - t * 0.8],
      ['gstab',   1.2],
      ['mine',    1.4 - t * 0.5],
      ['gtrap',   1.3 - t * 0.4],
      ['srocket', 0.8 + t * 1.4],
      ['tri',     0.6 + t * 0.9],
      ['hrocket', 0.15 + t * 1.5],
      ['emp',     0.15 + t * 1.1],
      ['decoy',   0.5 + t * 0.6],
      ['warp',    0.12 + t * 0.7],
      ['meteor',  t > 0.55 ? (t - 0.55) * 1.1 : 0],
      ['gravity', 0.07 + (t > 0.5 ? (t - 0.5) * 0.4 : 0)],
    ];
    let sum = 0; for (const e of w) sum += Math.max(e[1], 0);
    let r = rnd() * sum;
    for (const e of w) { r -= Math.max(e[1], 0); if (r <= 0) return e[0]; }
    return 'boost';
  }

  /* ---------- combat numbers (server-authoritative) ------------ */
  const DMG = {
    maxHp: 100,
    asteroidDirect: 100,
    asteroidNearMax: 40,
    asteroidDirectR: 4.5,
    asteroidShockR: 14.0,
    hrocket: 45,
    srocket: 35,
    mine: 35,
    emp: 6,
    ram: 12,
    rockMax: 7,        // clamp on client-reported rock hits
    landingMax: 16,    // clamp on client-reported hard landings
  };

  const COMBAT = {
    useCooldownMs: 500,
    srocketSpeed: 48, srocketLifeMs: 3000, srocketHitR: 2.8,
    hrocketSpeed: 34, hrocketLifeMs: 6500, hrocketHitR: 2.8, hrocketTurn: 3.2,
    mineArmMs: 1000, mineLifeMs: 45000, mineTriggerR: 4.2,
    empR: 26, empImpairMs: 3500,
    trapR: 7.5, trapLifeMs: 25000,
    shieldMs: 10000,
    boostMs: 4500,
    gstabMs: 5000,
    decoyMs: 4000,
    respawnMs: 3500,
    invulnMs: 3000,
    repairAmount: 40,
    carHitR: 2.7,           // car-vs-car collision radius
    astTargetChance: 0.75,  // odds a rock hunts a racer vs random track point
    astMinWarnMs: 2300,     // never less dodge time than this
    triSpread: 0.16, triDmg: 22,
    gravityMs: 11000,       // universal GRAV WAVE duration
    gravityLow: 0.35, gravityHeavy: 1.85,
  };

  /* ---------- pulse blaster (everyone carries one) ------------- */
  const GUN = {
    shots: 6,            // magazine
    fireGapMs: 240,      // min ms between shots
    rechargeMs: 3500,    // empty → full again (the "gap")
    speed: 70, lifeMs: 1100, hitR: 2.6, dmg: 8,
  };

  /* ---------- aliens (humanoid hostiles) ------------------------ */
  const ALIEN = {
    maxAlive: 3,
    spawnMsMin: 10000, spawnMsMax: 18000,
    lifeMs: 45000,       // gives up and leaves after this
    hp: 30,
    speed: 11,           // chases, but a healthy rover can outrun it
    aggroR: 120,         // hunts the nearest racer inside this
    attackR: 42,         // opens fire from here
    attackMs: 1400,
    boltSpeed: 26, boltLifeMs: 2600, dmg: 8,   // ranged bolt (dodgeable)
    meleeR: 6, meleeDmg: 12,                    // claw swipe up close
    hitProxR: 4.6,       // proximity fuse: your shots detonate this close
    runOverR: 3.0, runOverSpeed: 4,  // drive over one this fast = squashed
  };

  /* ---------- terrain hazard zones (fixed, on the ring) -------- */
  // sector: {a0,a1, kind}. radius band = trackRadius(a) ± 40
  const ZONES = [
    { kind: 'slip',  a0: 1.15, a1: 2.00 },  // slippery regolith
    { kind: 'slip',  a0: 4.50, a1: 5.00 },
    { kind: 'rough', a0: 3.30, a1: 4.10 },  // boulder washboard
    { kind: 'rough', a0: 0.10, a1: 0.55 },
  ];
  // circular low-gravity jump pads
  const JUMP_PADS = [0.75, 2.65, 5.45].map(a => ({
    a, x: Math.cos(a) * trackRadius(a), z: Math.sin(a) * trackRadius(a), r: 13, gscale: 0.42,
  }));

  function zoneAt(x, z) {
    const a = (Math.atan2(z, x) + TAU) % TAU;
    const r = Math.hypot(x, z);
    const tr = trackRadius(a);
    if (Math.abs(r - tr) > 42) return null;
    for (const s of ZONES) if (a >= s.a0 && a <= s.a1) return s.kind;
    return null;
  }

  /* ---------- net ---------------------------------------------- */
  const NET = {
    snapHz: 15,
    clientHz: 15,
    interpMs: 120,
    reconnectGraceMs: 30000,
    finishGraceMs: 30000, // others get this long after first finisher
  };

  const PLAYER_COLORS = [0x4fd2ff, 0xffb347, 0x7dff7a, 0xff6b9e, 0xc59bff, 0xfff36b, 0xff8d5c, 0x9ef7e0];

  // flags bitmask for snapshots
  const F = { DRIFT: 1, AIR: 2, DEAD: 4, SHIELD: 8, EMP: 16, INVULN: 32, BOOST: 64, LIGHTS: 128, FINISHED: 256 };

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  return {
    TAU, WORLD, trackRadius, GATE_COUNT, gatePositions, gateRadius,
    CRATES, CRATE_RESPAWN_MS, CRATE_PICK_R, MAX_ITEMS,
    ITEMS, rollItem, DMG, COMBAT, GUN, ALIEN, ZONES, JUMP_PADS, zoneAt,
    NET, PLAYER_COLORS, F, mulberry32,
  };
});
