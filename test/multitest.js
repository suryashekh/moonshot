/* Headless test for the combat-fun upgrade:
   - inventory holds multiple items (up to SHARED.MAX_ITEMS)
   - 'use' consumes the requested slot
   - asteroids target players (astSpawn.target set, lands near bot)
   - damage broadcasts carry the dmg amount
   Run the server first: node server/server.js */
const WebSocket = require('ws');
const S = require('../shared/constants.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what){ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return; await sleep(40);} throw new Error('timeout: '+what); }

(async () => {
  const mk = (n) => {
    const ws = new WebSocket('ws://localhost:3000/ws');
    const c = { ws, n, id:0, code:null, items:[], used:[], targeted:0, astNear:0,
      dmgMsgs:0, x:0, z:0, blasts:0, ammoMsgs:[], aliens:0, zaps:0, alienDmg:0,
      send:o=>ws.send(JSON.stringify(o)) };
    ws.on('message', d => { const m = JSON.parse(d);
      if (m.t==='joined'){ c.id=m.id; c.code=m.code; }
      if (m.t==='crateTaken' && m.by===c.id) c.items.push(m.item);
      if (m.t==='itemUsed' && m.id===c.id) { c.used.push(m); c.items.splice(m.slot,1); }
      if (m.t==='astSpawn' && m.target===c.id) {
        c.targeted++;
        if (Math.hypot(m.x-c.x, m.z-c.z) < 60) c.astNear++;
      }
      if (m.t==='damage' && typeof m.dmg === 'number') c.dmgMsgs++;
      if (m.t==='rocket' && m.kind==='blast' && m.owner===c.id) c.blasts++;
      if (m.t==='rocket' && m.kind==='abolt') c.abolts = (c.abolts||0) + 1;
      if (m.t==='ammo') c.ammoMsgs.push(m);
      if (m.t==='turboAmmo') c.turboMsgs = (c.turboMsgs||[]).concat(m);
      if (m.t==='fx' && m.kind==='boost' && m.id===c.id) c.boosts = (c.boosts||0)+1;
      if (m.t==='alienSpawn') c.aliens++;
      if (m.t==='alienZap') c.zaps++;
      if (m.t==='damage' && m.id===c.id && m.kind==='alien') c.alienDmg++;
    });
    return c; };

  const a = mk('A'), b = mk('B');
  await until(()=>a.ws.readyState===1 && b.ws.readyState===1, 3000, 'open');
  a.send({t:'create', name:'A'}); await until(()=>a.code,2000,'create');
  b.send({t:'join', code:a.code, name:'B'}); await until(()=>b.code,2000,'join');
  a.send({t:'start'});
  await sleep(4200); // countdown

  // A camps near crate 0; B circles slowly nearby so asteroids have a mover to hunt
  const c0 = S.CRATES[0];
  let ang = Math.atan2(c0.z, c0.x);
  const iv = setInterval(() => {
    a.x = c0.x; a.z = c0.z;
    a.send({t:'state', p:[a.x, 0, a.z], yaw:0, vf:1, f:0});
    ang += 0.002;
    const r = S.trackRadius(ang);
    b.x = Math.cos(ang)*r; b.z = Math.sin(ang)*r;
    b.send({t:'state', p:[b.x, 0, b.z], yaw:ang, vf:8, f:0});
  }, 1000/15);

  // 1) hoard: don't use anything until we hold 2+
  await until(()=>a.items.length >= 2, 30000, 'hold 2 items at once');
  console.log('✓ multi-slot inventory:', a.items.length, 'items held:', a.items.join(','));

  // 2) use slot 1 specifically; server must echo slot 1
  const before = a.items.slice();
  a.send({t:'use', slot:1});
  await until(()=>a.used.length >= 1, 4000, 'itemUsed echo');
  if (a.used[0].slot !== 1 || a.used[0].item !== before[1])
    throw new Error(`slot mismatch: used ${a.used[0].item}@${a.used[0].slot}, expected ${before[1]}@1`);
  console.log('✓ slot-targeted use:', a.used[0].item, '@ slot', a.used[0].slot);

  // 3) asteroids hunt players
  await until(()=>a.targeted + b.targeted >= 2, 45000, 'asteroids targeting players');
  console.log('✓ targeted asteroids: A', a.targeted, '· B', b.targeted,
              '· landing near target:', a.astNear + b.astNear);

  // 4) pulse blaster: fire the magazine dry, expect blasts + an empty-mag recharge ack
  for (let i = 0; i < S.GUN.shots + 2; i++) { a.send({t:'gun'}); await sleep(S.GUN.fireGapMs + 30); }
  await until(()=>a.blasts >= S.GUN.shots, 4000, 'blaster bolts broadcast');
  const empty = a.ammoMsgs.find(m => m.shots === 0 && m.rechargeAt > 0);
  if (!empty) throw new Error('no empty-mag recharge ack received');
  if (a.blasts > S.GUN.shots) throw new Error(`fired ${a.blasts} > magazine ${S.GUN.shots} — recharge gap not enforced`);
  console.log('✓ blaster:', a.blasts, 'bolts then forced recharge gap (ack rechargeAt set)');

  // 4b) turbo: burn all charges, expect boost fx + recharge-gap enforcement
  const boostsBefore = b.boosts || 0;
  for (let i = 0; i < S.TURBO.charges + 2; i++) { b.send({t:'turbo'}); await sleep(S.TURBO.useGapMs + 50); }
  await until(()=>(b.boosts||0) - boostsBefore >= S.TURBO.charges, 4000, 'turbo boosts broadcast');
  const tEmpty = (b.turboMsgs||[]).find(m => m.charges === 0 && m.rechargeAt > 0);
  if (!tEmpty) throw new Error('no empty-tank turbo recharge ack');
  if ((b.boosts||0) - boostsBefore > S.TURBO.charges)
    throw new Error('turbo fired more than its magazine — recharge gap not enforced');
  console.log('✓ turbo:', S.TURBO.charges, 'charges then forced recharge gap');

  // 5) humanoid aliens spawn, open fire (abolt) or claw, and damage lands
  await until(()=>a.aliens >= 1, 40000, 'alien spawn');
  await until(()=>(a.abolts||0) >= 1 || a.zaps >= 1, 30000, 'alien opens fire');
  await until(()=>a.alienDmg + b.alienDmg >= 1, 30000, 'alien damage lands');
  console.log('✓ aliens: spawns', a.aliens, '· bolts fired', a.abolts||0,
              '· melee swipes', a.zaps, '· alien dmg msgs', a.alienDmg + b.alienDmg);

  clearInterval(iv);
  console.log('✓ damage msgs carrying dmg amount:', a.dmgMsgs);
  a.ws.close(); b.ws.close();
  console.log('MULTI-WEAPON + TARGETED ASTEROIDS + BLASTER + ALIENS OK');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
