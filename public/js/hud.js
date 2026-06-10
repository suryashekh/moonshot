/* ================================================================
   HUD — DOM telemetry (base sim panels preserved) + race vitals:
   hp bar, item slot, rank/lap/gate, timers, distance to gate,
   lock-on banner, damage flash, respawn overlay, killfeed and the
   Tab scoreboard. Throttled to ~10 Hz like the original.
   ================================================================ */
(function () {
  const S = SHARED, clamp = G.clamp;
  const $ = (id) => document.getElementById(id);

  const elSpeed = $('speed'), elStatus = $('status'), elSlip = $('slipfill');
  const elAlt = $('alt'), elOdo = $('odo');
  const elHp = $('hpfill'), elHpbar = $('hpbar'), elShield = $('shieldtag');
  const elIts = [$('it0'), $('it1'), $('it2'), $('it3'), $('it4')], elIname = $('itemname');
  const elHit = $('hitmark');
  const elRank = $('rank'), elLap = $('lapline'), elTimers = $('timers');
  const elBest = $('rbest'), elCp = $('cpdist'), elConn = $('conn');
  const elPname = $('pname'), elFeed = $('feed'), elAlert = $('alert');
  const elLock = $('lockon'), elDmg = $('dmgflash');
  const elResp = $('respawnOv'), elRespIn = $('respawnIn');
  const elScore = $('score'), elScoreBody = $('scoreBody');

  let lastHud = 0;

  function ord(n) {
    return n + (['th', 'st', 'nd', 'rd'][((n % 100) - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  }

  function update(now) {
    if (now - lastHud < 100) return;
    lastHud = now;
    const r = G.rover, st = G.state, sNow = G.serverNow();

    /* original telemetry */
    const hSpeed = Math.hypot(r.vel.x, r.vel.z);
    elSpeed.innerHTML = Math.round(hSpeed * 3.6) + '<small>KM/H</small>';
    const skid = Math.abs(r.vL);
    let stTxt = 'GROUNDED', cls = '';
    if (st.deadUntil > sNow) { stTxt = 'DESTROYED'; cls = 'skid'; }
    else if (!r.grounded && r.airTime > 0.15) { stTxt = 'AIRBORNE'; cls = 'air'; }
    else if (skid > 1.6) { stTxt = 'SKIDDING'; cls = 'skid'; }
    elStatus.textContent = stTxt;
    elStatus.className = 'val ' + cls;
    elSlip.style.width = Math.round(clamp(skid / 4, 0, 1) * 100) + '%';
    elAlt.textContent = Math.max(0, r.pos.y - r.centerGy).toFixed(1) + ' m';
    elOdo.textContent = (r.odo / 1000).toFixed(2) + ' km';

    /* vitals */
    elPname.textContent = st.myName;
    elPname.style.color = '#' + st.myColor.toString(16).padStart(6, '0');
    const hpPct = clamp(st.hp / S.DMG.maxHp, 0, 1);
    elHp.style.width = (hpPct * 100) + '%';
    elHpbar.classList.toggle('low', hpPct < 0.5 && hpPct >= 0.25);
    elHpbar.classList.toggle('crit', hpPct < 0.25);
    elShield.style.display = st.shieldUntil > sNow ? 'inline-block' : 'none';

    const sel = Math.min(st.itemSel | 0, Math.max(st.items.length - 1, 0));
    for (let i = 0; i < elIts.length; i++) {
      const it = st.items[i] ? S.ITEMS[st.items[i]] : null;
      elIts[i].textContent = it ? it.icon : '—';
      elIts[i].classList.toggle('empty', !it);
      elIts[i].classList.toggle('sel', !!it && i === sel);
    }
    const cur = st.items[sel] ? S.ITEMS[st.items[sel]] : null;
    elIname.textContent = cur
      ? cur.name + ' · Shift fire · Q/wheel swap'
      : 'NO PAYLOAD · grab a crate';

    /* race panel */
    if (st.phase === 'race' || st.phase === 'end') {
      elRank.textContent = st.finished ? 'FIN ' + ord(st.rank) : ord(st.rank);
      elLap.textContent = 'LAP ' + Math.min(st.lap, S.WORLD.laps) + '/' + S.WORLD.laps +
        ' · GATE ' + (st.nextGate + 1) + '/' + S.GATE_COUNT;
      const t = st.raceStartTs ? Math.max(0, sNow - st.raceStartTs) : 0;
      elTimers.textContent = G.fmtMs(t);
      elBest.textContent = 'BEST ' + G.fmtMs(st.bestLap);

      const g = G.GATES[st.nextGate];
      if (g && !st.finished) {
        const d = Math.hypot(r.pos.x - g.x, r.pos.z - g.z);
        elCp.textContent = Math.round(d) + ' m → GATE ' + (st.nextGate + 1);
      } else elCp.textContent = st.finished ? 'RACE COMPLETE' : '';
    }

    /* respawn countdown */
    if (st.deadUntil > sNow) {
      elResp.classList.add('show');
      elRespIn.textContent = Math.ceil((st.deadUntil - sNow) / 1000);
    } else elResp.classList.remove('show');
  }

  /* ---------------- transient widgets ---------------- */
  function feed(text) {
    const div = document.createElement('div');
    div.className = 'feeditem';
    div.textContent = text;
    elFeed.prepend(div);
    while (elFeed.children.length > 5) elFeed.lastChild.remove();
    setTimeout(() => { div.classList.add('fade'); setTimeout(() => div.remove(), 600); }, 4200);
  }

  function alert(text, ms) {
    elAlert.textContent = text;
    elAlert.classList.add('show');
    clearTimeout(alert._t);
    alert._t = setTimeout(() => elAlert.classList.remove('show'), ms || 2200);
  }

  let lockT = 0;
  function lockOn() {
    elLock.classList.add('show');
    clearTimeout(lockT);
    lockT = setTimeout(() => elLock.classList.remove('show'), 2600);
  }

  function damageFlash() {
    elDmg.classList.remove('show');
    void elDmg.offsetWidth;            // restart CSS animation
    elDmg.classList.add('show');
  }

  /* attacker feedback: your weapon connected */
  const KIND_NAMES = {
    srocket: 'ROCKET', hrocket: 'HOMING RKT', mine: 'MINE', emp: 'EMP',
    ram: 'RAM', asteroid: 'METEOR',
  };
  function hitConfirm(dmg, kind) {
    elHit.textContent = '−' + dmg + '  ' + (KIND_NAMES[kind] || 'HIT');
    elHit.classList.remove('show');
    void elHit.offsetWidth;
    elHit.classList.add('show');
    G.beep(1180, 60, 'square', 0.07);
    setTimeout(() => G.beep(1560, 80, 'square', 0.06), 60);
  }

  /* takedown banner + streak counter (reset when you die) */
  let streak = 0;
  function takedown(victimName) {
    streak++;
    const tag = streak >= 3 ? ' — RAMPAGE ×' + streak : streak === 2 ? ' — DOUBLE!' : '';
    alert('💥 TAKEDOWN: ' + victimName + tag, 2600);
    G.beep(520, 90, 'sawtooth', 0.08);
    setTimeout(() => G.beep(780, 90, 'sawtooth', 0.08), 90);
    setTimeout(() => G.beep(1040, 160, 'sawtooth', 0.08), 180);
  }
  function resetStreak() { streak = 0; }

  function empHit(ms) {
    alert('⌁ EMP — SYSTEMS IMPAIRED', ms);
    document.body.classList.add('glitch');
    setTimeout(() => {
      if (G.state.flareUntil < G.serverNow()) document.body.classList.remove('glitch');
    }, ms);
  }

  function setConn(s, ok) {
    elConn.textContent = s;
    elConn.className = ok ? 'ok' : 'bad';
  }

  /* scoreboard (hold Tab) */
  function showScore(on) {
    if (!on) { elScore.classList.remove('show'); return; }
    elScoreBody.innerHTML = '';
    const rows = [];
    const meRow = {
      rank: G.state.rank, name: G.state.myName + ' (YOU)', color: G.state.myColor,
      lap: G.state.lap, hp: G.state.hp,
    };
    rows.push(meRow);
    for (const r of G.remotes.values()) {
      rows.push({ rank: r.rank, name: r.name, color: r.color, lap: r.lap, hp: r.hp });
    }
    rows.sort((a, b) => a.rank - b.rank);
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td>${r.rank}</td>` +
        `<td style="color:#${r.color.toString(16).padStart(6, '0')}">${r.name}</td>` +
        `<td>L${Math.min(r.lap, S.WORLD.laps)}</td>` +
        `<td>${r.hp}</td>`;
      elScoreBody.appendChild(tr);
    }
    elScore.classList.add('show');
  }

  G.hud = { update, feed, alert, lockOn, damageFlash, empHit, setConn, showScore, hitConfirm, takedown, resetStreak };
})();
