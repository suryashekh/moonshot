/* ================================================================
   UTIL — global namespace, deterministic noise (ported verbatim
   from the base simulator so terrain is bit-identical), helpers,
   tiny WebAudio beeper for race cues.
   Everything hangs off window.G so plain <script> files can share
   state without a bundler.
   ================================================================ */
window.G = {};

(function () {
  const TAU = Math.PI * 2;

  G.CFG = {
    terrainSize: 700,
    terrainSeg: 256,
    gravity: 1.62,
    maxSpeed: 14.0,
    maxReverse: 5.0,
    engineAccel: 7.0,
    brakeAccel: 12.0,
    rollResist: 0.22,
    latGrip: 2.6,
    steerRate: 1.55,
    wheelRadius: 0.42,
    trackWidth: 1.8,
    wheelBase: 2.3,
    dustCount: 2600,
  };
  G.HALF = G.CFG.terrainSize / 2;
  G.TAU = TAU;

  G.clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  G.lerp = (a, b, t) => a + (b - a) * t;

  G.mulberry32 = function (seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  function hash2(x, y) {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return n - Math.floor(n);
  }
  function vnoise2(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return G.lerp(G.lerp(a, b, u), G.lerp(c, d, u), v);
  }
  function fbm2(x, y, oct) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { v += vnoise2(x * f, y * f) * amp; f *= 2.03; amp *= 0.5; }
    return v;
  }
  function hash3(x, y, z) {
    const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
    return n - Math.floor(n);
  }
  function vnoise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
    const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
    const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
    const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
    const x00 = G.lerp(c000, c100, u), x10 = G.lerp(c010, c110, u);
    const x01 = G.lerp(c001, c101, u), x11 = G.lerp(c011, c111, u);
    return G.lerp(G.lerp(x00, x10, v), G.lerp(x01, x11, v), w);
  }
  function fbm3(x, y, z, oct) {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < oct; i++) { v += vnoise3(x * f, y * f, z * f) * amp; f *= 2.03; amp *= 0.5; }
    return v;
  }
  G.hash2 = hash2; G.vnoise2 = vnoise2; G.fbm2 = fbm2;
  G.hash3 = hash3; G.vnoise3 = vnoise3; G.fbm3 = fbm3;

  G.makeGlowTexture = function () {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    return tex;
  };

  /* ----- tiny synth: countdown / lock-on / pickup cues ----- */
  let actx = null;
  function audio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    return actx;
  }
  G.beep = function (freq, ms, type, gain) {
    const a = audio(); if (!a) return;
    if (a.state === 'suspended') a.resume();
    const o = a.createOscillator(), gn = a.createGain();
    o.type = type || 'square';
    o.frequency.value = freq;
    gn.gain.value = gain || 0.05;
    gn.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + ms / 1000);
    o.connect(gn).connect(a.destination);
    o.start(); o.stop(a.currentTime + ms / 1000);
  };
  G.boom = function (gain) {
    const a = audio(); if (!a) return;
    const len = 0.35, buf = a.createBuffer(1, a.sampleRate * len, a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
    const src = a.createBufferSource(); src.buffer = buf;
    const gn = a.createGain(); gn.gain.value = gain || 0.16;
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 420;
    src.connect(f).connect(gn).connect(a.destination); src.start();
  };

  // game-wide mutable state shared between modules
  G.state = {
    phase: 'menu',        // menu | lobby | countdown | race | end
    myId: 0, myName: 'PILOT', myColor: 0x4fd2ff, hostId: 0,
    raceStartTs: 0, serverOffset: 0, rtt: 0,
    nextGate: 0, lap: 1, rank: 1, bestLap: 0, finished: false,
    hp: 100, items: [], itemSel: 0, controlsLocked: true,
    shieldUntil: 0, empUntil: 0, boostUntil: 0, gstabUntil: 0,
    invulnUntil: 0, deadUntil: 0, decoyUntil: 0,
    quakeUntil: 0, stormUntil: 0, flareUntil: 0,
    gravUntil: 0, gravScale: 1,
  };
  G.serverNow = () => performance.now() + G.state.serverOffset; // mapped to server Date.now()
})();
