/* ================================================================
   RACE — glowing checkpoint gates (cyan = my next, amber = rest),
   beacon beam over the next gate, pass-flash, canvas minimap and
   end-screen population. Gate VALIDATION lives on the server;
   this module is purely presentational + local timing display.
   ================================================================ */
(function () {
  const S = SHARED;
  const GATES = S.gatePositions();
  G.GATES = GATES;

  const COL_NEXT = 0x35e0ff, COL_OTHER = 0xffb347, COL_PASS = 0x7dff7a;

  const gateObjs = [];
  (function buildGates() {
    for (const g of GATES) {
      const grp = new THREE.Group();
      const gy = G.terrainHeight(g.x, g.z);
      grp.position.set(g.x, gy, g.z);
      grp.rotation.y = g.heading;

      // torus arch
      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(8.5, 0.38, 10, 40, Math.PI),
        new THREE.MeshBasicMaterial({ color: COL_OTHER })
      );
      torus.position.y = 0.4;
      grp.add(torus);

      // pylons
      const pyl = new THREE.MeshBasicMaterial({ color: COL_OTHER });
      for (const sx of [-8.5, 8.5]) {
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.6, 3.4, 8), pyl);
        p.position.set(sx, 1.7, 0);
        grp.add(p);
      }

      // glow sprite at the apex
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: G.glowTex, color: COL_OTHER, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8,
      }));
      glow.scale.setScalar(9);
      glow.position.y = 9.2;
      grp.add(glow);

      // beacon beam (visible only on my next gate)
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.5, 1.6, 90, 10, 1, true),
        new THREE.MeshBasicMaterial({
          color: COL_NEXT, transparent: true, opacity: 0.16,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      beam.position.y = 45;
      beam.visible = false;
      grp.add(beam);

      G.scene.add(grp);
      gateObjs.push({ grp, torus, pyl, glow, beam, flashT: 0, idx: g.i });
    }
  })();

  /* ---------------- launch ramps + overdrive strips ---------------- */
  const speedQuads = [];
  (function buildTrackFurniture() {
    // ramps: amber wedge sitting on the racing line, pointing along travel
    for (const rp of S.RAMPS) {
      const grp = new THREE.Group();
      const gy = G.terrainHeight(rp.x, rp.z);
      grp.position.set(rp.x, gy, rp.z);
      grp.rotation.y = rp.heading;

      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(8.5, 0.35, 7),
        new THREE.MeshStandardMaterial({ color: 0x3c4754, metalness: 0.7, roughness: 0.4 })
      );
      deck.rotation.x = -0.33;            // inclined into the direction of travel
      deck.position.set(0, 1.0, 0);
      deck.castShadow = true; deck.receiveShadow = true;
      grp.add(deck);

      for (const sx of [-4.0, 4.0]) {     // glowing edge rails
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.12, 7),
          new THREE.MeshBasicMaterial({ color: 0xffb347 })
        );
        rail.rotation.x = -0.33;
        rail.position.set(sx, 1.22, 0);
        grp.add(rail);
      }
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: G.glowTex, color: 0xffb347, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5,
      }));
      glow.scale.setScalar(7);
      glow.position.y = 2.2;
      grp.add(glow);
      G.scene.add(grp);
    }

    // overdrive strips: pulsing cyan quads along each speed sector
    const mat = new THREE.MeshBasicMaterial({
      color: 0x3fe0ff, transparent: true, opacity: 0.22,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    for (const s of S.ZONES) {
      if (s.kind !== 'speed') continue;
      const steps = 7;
      for (let i = 0; i < steps; i++) {
        const a = s.a0 + (s.a1 - s.a0) * ((i + 0.5) / steps);
        const r = S.trackRadius(a);
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.4), mat);
        quad.rotation.x = -Math.PI / 2;
        quad.rotation.z = -Math.atan2(-Math.sin(a) * r, Math.cos(a) * r);
        quad.position.set(x, G.terrainHeight(x, z) + 0.3, z);
        G.scene.add(quad);
        speedQuads.push({ quad, ph: i * 0.7 });
      }
    }
  })();

  /* ---------------- next-gate pointer + wrong-way detector ----------------
     A cyan arrow floats over MY rover, always aiming at my next gate, so
     the direction of travel is never ambiguous. Driving away from the gate
     at speed for >1 s flashes the WRONG WAY banner. */
  const gateArrow = (function () {
    const grp = new THREE.Group();
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.55, 1.6, 10),
      new THREE.MeshBasicMaterial({ color: 0x35e0ff })
    );
    cone.rotation.x = Math.PI / 2;       // point along +Z
    cone.position.z = 0.5;
    grp.add(cone);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: G.glowTex, color: 0x35e0ff, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5,
    }));
    glow.scale.setScalar(2.6);
    grp.add(glow);
    grp.visible = false;
    G.scene.add(grp);
    return grp;
  })();

  const elWrong = document.getElementById('wrongway');
  let wrongSince = 0;

  function updateGuidance(dt) {
    const st = G.state, r = G.rover;
    const racing = st.phase === 'race' && !st.finished && !(st.deadUntil > G.serverNow());
    gateArrow.visible = racing;
    if (!racing) { elWrong.classList.remove('show'); wrongSince = 0; return; }

    const g = GATES[st.nextGate];
    const dx = g.x - r.pos.x, dz = g.z - r.pos.z;
    gateArrow.position.set(r.pos.x, r.pos.y + 4.4 + Math.sin(performance.now() * 0.004) * 0.25, r.pos.z);
    gateArrow.rotation.y = Math.atan2(dx, dz);

    // wrong way: moving fast with velocity pointing away from the next gate
    const sp = Math.hypot(r.vel.x, r.vel.z);
    const d = Math.hypot(dx, dz) || 1;
    const dot = (r.vel.x * dx + r.vel.z * dz) / (d * Math.max(sp, 1e-3));
    if (sp > 4 && dot < -0.45) {
      wrongSince += dt;
      if (wrongSince > 1.0) {
        if (!elWrong.classList.contains('show')) {
          elWrong.classList.add('show');
          G.beep(220, 250, 'square', 0.07);
        }
      }
    } else {
      wrongSince = 0;
      elWrong.classList.remove('show');
    }
  }

  function setGateColor(o, hex) {
    o.torus.material.color.setHex(hex);
    o.pyl.color.setHex(hex);
    o.glow.material.color.setHex(hex);
  }

  G.flashGate = function (idx) {
    const o = gateObjs[idx];
    if (o) o.flashT = 0.7;
    G.beep(960, 110, 'sine', 0.07);
  };

  function updateGates(dt) {
    const next = G.state.nextGate;
    const t = performance.now() * 0.004;
    for (const o of gateObjs) {
      if (o.flashT > 0) {
        o.flashT -= dt;
        setGateColor(o, COL_PASS);
        o.glow.material.opacity = 1;
      } else if (o.idx === next && G.state.phase === 'race' && !G.state.finished) {
        setGateColor(o, COL_NEXT);
        o.glow.material.opacity = 0.7 + 0.3 * Math.sin(t * 2.2);
        o.beam.visible = true;
      } else {
        setGateColor(o, COL_OTHER);
        o.glow.material.opacity = 0.55;
        o.beam.visible = false;
      }
      if (o.idx !== next) o.beam.visible = false;
    }
  }

  /* ---------------- minimap ---------------- */
  const mm = document.getElementById('minimap');
  const mctx = mm ? mm.getContext('2d') : null;
  const MMS = mm ? mm.width : 376;   // canvas backing-store px
  const SCALE = MMS / (S.WORLD.terrainSize + 40);
  const K = MMS / 150;          // stroke/dot scale vs original 150px design

  function w2m(x, z) { return [MMS / 2 + x * SCALE, MMS / 2 + z * SCALE]; }

  let mmLast = 0;
  function drawMinimap(now) {
    if (!mctx || now - mmLast < 120) return;
    mmLast = now;
    mctx.clearRect(0, 0, MMS, MMS);

    // track ring
    mctx.strokeStyle = 'rgba(150,170,190,0.5)';
    mctx.lineWidth = 1.4 * K;
    mctx.beginPath();
    for (let i = 0; i <= 72; i++) {
      const a = (i / 72) * S.TAU;
      const r = S.trackRadius(a);
      const [px, py] = w2m(Math.cos(a) * r, Math.sin(a) * r);
      i ? mctx.lineTo(px, py) : mctx.moveTo(px, py);
    }
    mctx.stroke();

    // gates
    for (const g of GATES) {
      const [px, py] = w2m(g.x, g.z);
      mctx.fillStyle = g.i === G.state.nextGate ? '#35e0ff' : 'rgba(255,179,71,0.85)';
      mctx.beginPath(); mctx.arc(px, py, (g.i === G.state.nextGate ? 3 : 2) * K, 0, S.TAU); mctx.fill();
    }

    // asteroid warnings
    if (G.asteroidWarnings) {
      mctx.fillStyle = 'rgba(255,70,60,0.85)';
      for (const a of G.asteroidWarnings()) {
        const [px, py] = w2m(a.x, a.z);
        mctx.beginPath(); mctx.arc(px, py, 2.6 * K, 0, S.TAU); mctx.fill();
      }
    }

    // aliens (green blips)
    if (G.alienDots) {
      mctx.fillStyle = 'rgba(61,255,154,0.9)';
      for (const a of G.alienDots()) {
        const [px, py] = w2m(a.x, a.z);
        mctx.beginPath(); mctx.arc(px, py, 2.4 * K, 0, S.TAU); mctx.fill();
      }
    }

    // remotes
    for (const r of G.remotes.values()) {
      const [px, py] = w2m(r.x, r.z);
      mctx.fillStyle = '#' + r.color.toString(16).padStart(6, '0');
      mctx.beginPath(); mctx.arc(px, py, 2.6 * K, 0, S.TAU); mctx.fill();
    }

    // me (triangle pointing along heading)
    const me = G.rover;
    const [px, py] = w2m(me.pos.x, me.pos.z);
    mctx.save();
    mctx.translate(px, py);
    mctx.rotate(Math.atan2(Math.sin(me.heading), Math.cos(me.heading)));
    mctx.fillStyle = '#ffffff';
    mctx.beginPath();
    mctx.moveTo(4.2 * K, 0); mctx.lineTo(-3 * K, 2.6 * K); mctx.lineTo(-3 * K, -2.6 * K);
    mctx.closePath(); mctx.fill();
    mctx.restore();
  }

  /* ---------------- countdown / end screen ---------------- */
  const elCount = document.getElementById('countdown');
  G.showCountdown = function (n) {
    elCount.textContent = n > 0 ? n : 'GO!';
    elCount.classList.add('show');
    setTimeout(() => elCount.classList.remove('show'), n > 0 ? 850 : 1100);
    G.beep(n > 0 ? 440 : 880, n > 0 ? 130 : 320, 'square', 0.07);
  };

  function fmtMs(ms) {
    if (!ms || ms <= 0) return '—';
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, h = Math.floor(ms % 1000 / 10);
    return `${m}:${String(s).padStart(2, '0')}.${String(h).padStart(2, '0')}`;
  }
  G.fmtMs = fmtMs;

  G.showEndScreen = function (results) {
    const body = document.getElementById('endBody');
    body.innerHTML = '';
    for (const r of results) {
      const tr = document.createElement('tr');
      const hex = '#' + r.color.toString(16).padStart(6, '0');
      tr.innerHTML =
        `<td>${r.rank}</td>` +
        `<td style="color:${hex}">${r.name}${r.id === G.state.myId ? ' (YOU)' : ''}</td>` +
        `<td>${r.finished ? fmtMs(r.totalMs) : 'DNF (L' + r.lap + ')'}</td>` +
        `<td>${fmtMs(r.bestLap)}</td>`;
      body.appendChild(tr);
    }
    document.getElementById('end').classList.add('show');
  };
  G.hideEndScreen = function () {
    document.getElementById('end').classList.remove('show');
  };

  G.updateRace = function (dt, now) {
    updateGates(dt);
    updateGuidance(dt);
    drawMinimap(now);
    // overdrive strips share one material — one pulse drives them all
    if (speedQuads.length) {
      speedQuads[0].quad.material.opacity = 0.16 + 0.1 * Math.sin(now * 0.006);
    }
  };
})();
