const WebSocket = require('ws');
const S = require('../shared/constants.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what){ const t0=Date.now(); while(Date.now()-t0<ms){ if(fn()) return; await sleep(40);} throw new Error('timeout: '+what); }
(async () => {
  const mk = (n) => { const ws = new WebSocket('ws://localhost:3000/ws');
    const c = { ws, n, id:0, code:null, item:null, used:0, mines:0, rockets:0, emps:0, fx:0,
      send:o=>ws.send(JSON.stringify(o)) };
    ws.on('message', d => { const m = JSON.parse(d);
      if (m.t==='joined'){ c.id=m.id; c.code=m.code; }
      if (m.t==='crateTaken' && m.by===c.id) c.item=m.item;
      if (m.t==='itemUsed' && m.id===c.id) c.used++;
      if (m.t==='mine') c.mines++;
      if (m.t==='rocket') c.rockets++;
      if (m.t==='empBlast') c.emps++;
      if (m.t==='fx') c.fx++;
    });
    return c; };
  const a = mk('A'), b = mk('B');
  await until(()=>a.ws.readyState===1 && b.ws.readyState===1, 3000, 'open');
  a.send({t:'create', name:'A'}); await until(()=>a.code,2000,'create');
  b.send({t:'join', code:a.code, name:'B'}); await until(()=>b.code,2000,'join');
  a.send({t:'start'});
  await sleep(4500); // countdown

  // park A on crate 0, B 30m away on the ring
  const c0 = S.CRATES[0];
  let picked = 0, t = 0;
  const iv = setInterval(() => {
    t += 1/15;
    a.send({t:'state', p:[c0.x, 0, c0.z], yaw:0, vf:1, f:0});
    b.send({t:'state', p:[c0.x+10, 0, c0.z], yaw:0, vf:1, f:0});
    if (a.item) { a.send({t:'use'}); picked++; a.item=null; }
  }, 1000/15);

  await until(()=>a.used >= 3, 40000, '3 items picked+used');  // crate respawns every 11s
  clearInterval(iv);
  console.log('✓ items used:', a.used, '· fx events:', a.fx, '· mines:', a.mines,
              '· rockets:', a.rockets, '· emp blasts:', a.emps);
  a.ws.close(); b.ws.close();
  console.log('ITEM PIPELINE OK');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
