/* Headless smoke test: boots nothing itself (run the server first),
   then drives two scripted clients: create → join → start →
   stream poses along the racing line → expect gate/lap/snap/crate
   traffic. Exits 0 on success, 1 on failure/timeout. */
const WebSocket = require('ws');
const S = require('../shared/constants.js');

const URL = 'ws://localhost:3000/ws';
const GATES = S.gatePositions();

function client(name) {
  const ws = new WebSocket(URL);
  const c = {
    name, ws, id: 0, code: null, msgs: {}, item: null,
    gatesPassed: 0, laps: 0, finished: false, hp: 100,
    send: (o) => ws.send(JSON.stringify(o)),
    count: (t) => c.msgs[t] || 0,
  };
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.msgs[m.t] = (c.msgs[m.t] || 0) + 1;
    if (m.t === 'joined') { c.id = m.id; c.code = m.code; }
    if (m.t === 'gate' && m.id === c.id) c.gatesPassed++;
    if (m.t === 'lap' && m.id === c.id) c.laps = m.lap;
    if (m.t === 'finish' && m.id === c.id) c.finished = true;
    if (m.t === 'crateTaken' && m.by === c.id) c.item = m.item;
    if (m.t === 'damage' && m.id === c.id) c.hp = m.hp;
    if (m.t === 'err') console.log(`[${name}] ERR:`, m.msg);
  });
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await sleep(50); }
  throw new Error('timeout waiting for: ' + what);
}

(async () => {
  const a = client('A'), b = client('B');
  await until(() => a.ws.readyState === 1 && b.ws.readyState === 1, 4000, 'sockets open');

  a.send({ t: 'create', name: 'ALPHA' });
  await until(() => a.code, 3000, 'A joined (create)');
  b.send({ t: 'join', code: a.code, name: 'BRAVO' });
  await until(() => b.code === a.code, 3000, 'B joined room');
  console.log('✓ room', a.code, 'A.id', a.id, 'B.id', b.id);

  a.send({ t: 'start' });
  await until(() => a.count('go') > 0 && b.count('go') > 0, 8000, 'GO after countdown');
  console.log('✓ countdown → GO, countdown msgs:', a.count('countdown'));

  // Drive both clients along the racing line at ~17 m/s (A), ~13 m/s (B).
  // Heading convention in the sim: pos += (sin(yaw), cos(yaw)) * v.
  function driver(c, speed) {
    let aAng = 0;                       // angle along the ring, starts at gate 0
    return setInterval(() => {
      const r0 = S.trackRadius(aAng);
      const x = Math.cos(aAng) * r0, z = Math.sin(aAng) * r0;
      aAng += (speed * (1 / 15)) / r0;  // ds = v*dt → dAng = ds/r
      const r1 = S.trackRadius(aAng);
      const nx = Math.cos(aAng) * r1, nz = Math.sin(aAng) * r1;
      const yaw = Math.atan2(nx - x, nz - z);  // sim convention: pos += (sin,cos)·v
      c.send({ t: 'state', p: [x, 0, z], yaw, vf: speed, f: 0 });
    }, 1000 / 15);
  }
  const da = driver(a, 45), db = driver(b, 38);

  // A uses its item whenever it has one
  const useTimer = setInterval(() => { if (a.item) { a.send({ t: 'use' }); a.item = null; } }, 800);

  await until(() => a.gatesPassed >= 3, 30000, 'A passes 3 gates');
  console.log('✓ A gates passed:', a.gatesPassed, '· B gates:', b.gatesPassed);

  await until(() => a.count('snap') > 30, 5000, 'snapshots flowing');
  console.log('✓ snapshots:', a.count('snap'), '· crates A picked:', a.count('crateTaken'));

  // B reports a rock hit → server-clamped damage should arrive
  b.send({ t: 'ouch', kind: 'rock', mag: 8 });
  await until(() => b.hp < 100, 3000, 'B damage applied');
  console.log('✓ B hp after rock ouch:', b.hp);

  // wait for at least one full lap from A (10 gates)
  await until(() => a.laps >= 2 || a.gatesPassed >= 10, 60000, 'A completes lap 1');
  console.log('✓ A lap counter:', a.laps, 'gates:', a.gatesPassed);

  console.log('✓ asteroid spawns seen:', a.count('astSpawn'),
              '· itemUsed:', a.count('itemUsed'),
              '· fx:', a.count('fx'),
              '· rockets:', a.count('rocket'));

  clearInterval(da); clearInterval(db); clearInterval(useTimer);
  a.ws.close(); b.ws.close();
  console.log('\nALL CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
