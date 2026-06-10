/* ================================================================
   NETWORK — single WebSocket to ws://<host>/ws.
   Streams the local pose at 15 Hz, estimates the server clock
   offset from snapshot timestamps + ping RTT, dispatches every
   server message to the rendering systems, and auto-reconnects
   with the per-player rejoin token (30 s server grace).
   ================================================================ */
(function () {
  const S = SHARED;
  let ws = null;
  let sendTimer = 0;
  let token = sessionStorage.getItem('lr_token') || null;
  let wantReconnect = false;
  let retries = 0;

  const net = {
    connected: false,
    send(obj) {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
    },
    host(name) { connect(() => net.send({ t: 'create', name })); },
    join(code, name) { connect(() => net.send({ t: 'join', code, name })); },
    start(solo) { net.send({ t: 'start', solo: !!solo }); },
    toLobby() { net.send({ t: 'toLobby' }); },
  };
  G.net = net;

  function connect(onOpen) {
    if (ws && ws.readyState <= 1) { if (onOpen && ws.readyState === 1) onOpen(); return; }
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = () => {
      net.connected = true;
      retries = 0;
      G.hud.setConn('LINK OK', true);
      if (onOpen) onOpen();
    };
    ws.onclose = () => {
      net.connected = false;
      G.hud.setConn('LINK LOST', false);
      if (wantReconnect && token && retries < 12) {
        retries++;
        setTimeout(() => connect(() => net.send({ t: 'rejoin', token })), 1200 + retries * 400);
      }
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      route(m);
    };
  }

  /* ---- 15 Hz pose stream + 2 s ping ---- */
  let lastState = 0, lastPing = 0;
  G.netTick = function (now) {
    if (!net.connected || G.state.phase === 'menu') return;
    if (now - lastState >= 1000 / S.NET.clientHz) {
      lastState = now;
      const r = G.rover, k = G.keys;
      let f = 0;
      if (Math.abs(r.vL) > 1.6) f |= S.F.DRIFT;
      if (!r.grounded) f |= S.F.AIR;
      if (G.myRig.lightsOn) f |= S.F.LIGHTS;
      net.send({
        t: 'state',
        p: [+r.pos.x.toFixed(2), +r.pos.y.toFixed(2), +r.pos.z.toFixed(2)],
        yaw: +r.heading.toFixed(3),
        vf: +r.vF.toFixed(2),
        f,
      });
    }
    if (now - lastPing > 2000) {
      lastPing = now;
      net.send({ t: 'ping', cts: now });
    }
  };

  /* ---- clock sync: offset = serverTs - perfNow (EMA) ---- */
  function syncClock(serverTs) {
    const o = serverTs - performance.now();
    const st = G.state;
    st.serverOffset = st.serverOffset === 0 ? o : st.serverOffset * 0.9 + o * 0.1;
  }

  /* ---------------- message router ---------------- */
  function route(m) {
    const st = G.state;
    switch (m.t) {
      case 'joined': {
        st.myId = m.id;
        st.myColor = m.color;
        st.hostId = m.hostId;
        token = m.token;
        sessionStorage.setItem('lr_token', token);
        wantReconnect = true;
        syncClock(m.serverNow);
        G.setMyColor(m.color);
        G.setCrates(m.crates || []);
        G.onJoined(m);            // main.js: show lobby UI
        if (m.rejoined && m.state === 'race') {
          st.phase = 'race';
          st.controlsLocked = false;
          st.items = m.myItems || [];
          st.itemSel = 0;
          G.enterGameView();
        }
        break;
      }
      case 'err':
        G.onLobbyError(m.msg);
        break;
      case 'host':
        st.hostId = st.myId;
        G.refreshLobby();
        break;
      case 'lobby':
        st.hostId = m.hostId;
        G.lobbyPlayers = m.players;
        // reconcile remote rovers with the roster
        for (const p of m.players) if (p.id !== st.myId) G.ensureRemote(p.id, p.name, p.color);
        for (const id of [...G.remotes.keys()]) {
          if (!m.players.find(p => p.id === id)) G.removeRemote(id);
        }
        G.refreshLobby();
        break;

      case 'raceSetup': {
        // grid: slot i → just behind gate 0, spread laterally
        const me = m.startGrid.find(e => e.id === st.myId);
        const g0 = G.GATES[0];
        const slot = me ? me.slot : 0;
        const row = Math.floor(slot / 2), side = (slot % 2) ? 1 : -1;
        const back = 14 + row * 7;
        const lat = side * 4.5;
        const sx = g0.x - Math.sin(g0.heading) * back + Math.cos(g0.heading) * lat;
        const sz = g0.z - Math.cos(g0.heading) * back - Math.sin(g0.heading) * lat;
        G.placeRoverAt(sx, sz, g0.heading);
        st.phase = 'countdown';
        st.controlsLocked = true;
        st.finished = false;
        st.hp = 100; st.items = []; st.itemSel = 0;
        st.gravUntil = 0; st.gravScale = 1;
        G.hud.resetStreak();
        if (G.resetGun) G.resetGun();
        if (G.clearAliens) G.clearAliens();
        st.lap = 1; st.nextGate = 0; st.bestLap = 0;
        st.shieldUntil = st.empUntil = st.boostUntil = st.gstabUntil = 0;
        st.deadUntil = st.invulnUntil = 0;
        G.clearAsteroids(); G.clearCombat();
        G.hideEndScreen();
        G.enterGameView();
        break;
      }
      case 'countdown':
        G.showCountdown(m.n);
        break;
      case 'go':
        syncClock(m.ts);
        st.raceStartTs = m.ts;
        st.phase = 'race';
        st.controlsLocked = false;
        G.showCountdown(0);
        break;

      case 'snap': {
        syncClock(m.ts);
        for (const e of m.ps) {
          const [id, x, y, z, yaw, vf, f, hp, lap, nextGate, rank] = e;
          if (id === st.myId) {
            st.hp = hp; st.rank = rank;
            st.finished = (f & S.F.FINISHED) !== 0;
            // lap/nextGate also arrive via 'gate'/'lap'; snap is the safety net
            st.lap = lap; st.nextGate = nextGate;
            if (f & S.F.SHIELD) { if (st.shieldUntil < G.serverNow()) st.shieldUntil = G.serverNow() + 500; }
            else st.shieldUntil = Math.min(st.shieldUntil, G.serverNow());
            continue;
          }
          const r = G.ensureRemote(id);
          if (r) { r.push(m.ts, x, y, z, yaw, vf, f); r.hp = hp; r.lap = lap; r.rank = rank; r.nextGate = nextGate; }
        }
        G.syncRockets(m.pr || []);
        if (G.syncAliens) G.syncAliens(m.al || []);
        break;
      }

      case 'gate':
        if (m.id === st.myId) {
          const passed = st.nextGate;
          st.nextGate = m.nextGate;
          G.flashGate(passed);
        }
        break;
      case 'lap':
        if (m.id === st.myId) {
          st.lap = m.lap;
          st.bestLap = m.bestLap;
          G.hud.alert('LAP ' + Math.min(m.lap, S.WORLD.laps) + ' — ' + G.fmtMs(m.lapMs));
          G.beep(700, 100, 'sine', 0.06); G.beep(1050, 160, 'sine', 0.06);
        } else {
          const r = G.remotes.get(m.id);
          if (r) G.hud.feed(r.name + ' → lap ' + Math.min(m.lap, S.WORLD.laps));
        }
        break;
      case 'finish':
        if (m.id === st.myId) {
          st.finished = true;
          st.bestLap = m.bestLap;
          G.hud.alert('🏁 FINISHED — ' + G.fmtMs(m.totalMs), 5000);
        } else {
          const r = G.remotes.get(m.id);
          G.hud.feed((r ? r.name : 'player') + ' finished!');
        }
        break;
      case 'raceEnd':
        st.phase = 'end';
        st.controlsLocked = true;
        G.showEndScreen(m.results);
        break;
      case 'toLobby':
        st.phase = 'lobby';
        st.controlsLocked = true;
        G.hideEndScreen();
        G.clearAsteroids(); G.clearCombat();
        if (G.clearAliens) G.clearAliens();
        G.enterLobbyView();
        break;

      /* asteroids */
      case 'astSpawn':
        G.onAstSpawn(m);
        if (m.target === st.myId) {
          G.hud.alert('⚠ ASTEROID LOCK — MOVE!', 1800);
          G.beep(980, 110, 'square', 0.08);
          setTimeout(() => G.beep(980, 110, 'square', 0.08), 180);
        }
        break;
      case 'astBoom':  G.onAstBoom(m);  break;
      case 'astKilled': {
        G.onAstKilled(m);
        if (m.by === st.myId) G.hud.feed('☄ asteroid destroyed (+nice shot)');
        break;
      }
      case 'shower':
        G.hud.alert('☄☄☄ METEOR SHOWER ☄☄☄', 3000);
        G.beep(140, 700, 'sawtooth', 0.08);
        break;
      case 'hazard': G.onHazard(m); break;

      /* items + combat */
      case 'crateTaken': G.onCrateTaken(m); break;
      case 'crateUp':    G.onCrateUp(m);    break;
      case 'itemUsed':   G.onItemUsed(m);   break;
      case 'itemStolen': G.onItemStolen(m); break;
      case 'fx':         G.onFx(m);         break;
      case 'rocket':     G.onRocket(m);     break;
      case 'rocketBoom': G.onRocketBoom(m); break;
      case 'mine':       G.onMine(m);       break;
      case 'mineGone':   G.onMineGone(m);   break;
      case 'mineBoom':   G.onMineBoom(m);   break;
      case 'trap':       G.onTrap(m);       break;
      case 'trapGone':   G.onTrapGone(m);   break;
      case 'empBlast':   G.onEmpBlast(m);   break;
      case 'lockOn':     G.onLockOn(m);     break;
      case 'meteorWarn': G.onMeteorWarn(m); break;
      case 'ammo':       G.onAmmo(m);       break;

      /* aliens */
      case 'alienSpawn': G.onAlienSpawn(m); break;
      case 'alienHit':   G.onAlienHit(m);   break;
      case 'alienDead':  G.onAlienDead(m);  break;
      case 'alienGone':  G.onAlienGone(m);  break;
      case 'alienZap':   G.onAlienZap(m);   break;

      /* universal gravity wave */
      case 'grav': {
        st.gravUntil = m.until;
        st.gravScale = m.scale;
        const who = m.by === st.myId ? 'YOU' : ((G.remotes.get(m.by) || {}).name || '?');
        G.hud.alert(m.scale < 1 ? '∿ LOW GRAVITY — ' + who + ' broke the moon!'
                                : '∿ HEAVY GRAVITY — ' + who + ' turned it up!', 3200);
        G.beep(m.scale < 1 ? 880 : 110, 700, 'sine', 0.09);
        break;
      }

      /* warp swap */
      case 'teleport': {
        if (m.id === st.myId) {
          st.nextGate = m.nextGate; st.lap = m.lap;
          st.invulnUntil = G.serverNow() + 1200;
          G.placeRoverAt(m.x, m.z, m.heading);
          G.hud.alert(m.by === st.myId ? '⇋ WARPED AHEAD' : '⇋ WARP-SWAPPED!', 2400);
          G.beep(1500, 200, 'sine', 0.08);
          G.beep(500, 350, 'sine', 0.06);
        } else {
          const r = G.remotes.get(m.id);
          if (r) r.buf.length = 0;   // drop stale interpolation through the warp
        }
        break;
      }

      case 'damage': {
        if (m.id === st.myId) {
          st.hp = m.hp;
          G.hud.damageFlash();
          G.applyKnockback(m.fx);
          if (G.addCamShake) G.addCamShake(0.22);
        } else if (m.src === st.myId) {
          // my weapon connected — instant feedback
          G.hud.hitConfirm(m.dmg, m.kind);
          const v = G.remotes.get(m.id);
          if (v) G.hud.feed('✕ you hit ' + v.name + ' −' + m.dmg);
        }
        break;
      }
      case 'kill': {
        const vName = m.victim === st.myId ? 'YOU' :
          (G.remotes.get(m.victim) || {}).name || 'player';
        const bName = m.by === st.myId ? 'YOU' :
          (G.remotes.get(m.by) || {}).name || (m.kind === 'asteroid' ? 'an asteroid' : 'hazard');
        G.hud.feed('💥 ' + vName + ' destroyed by ' + bName);
        if (m.victim === st.myId) {
          st.deadUntil = G.serverNow() + m.respawnIn;
          G.hud.resetStreak();
          G.boom(0.2);
          G.explosion(G.rover.pos.x, G.rover.pos.z, 1.6);
        } else if (m.by === st.myId) {
          G.hud.takedown(vName);
        }
        break;
      }
      case 'respawn': {
        if (m.id === st.myId) {
          st.deadUntil = 0;
          st.invulnUntil = G.serverNow() + m.invulnMs;
          st.hp = 100;
          G.placeRoverAt(m.x, m.z, m.heading);
        }
        break;
      }

      case 'pong': {
        const rtt = performance.now() - m.cts;
        G.state.rtt = rtt;
        syncClock(m.sts + rtt / 2);
        break;
      }
    }
  }
})();
