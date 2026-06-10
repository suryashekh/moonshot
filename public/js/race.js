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
  // proper wedge ramp (custom geometry, like a skate ramp): low open
  // entry edge facing oncoming traffic, deck rising to the launch lip,
  // solid side walls, open at the top — the opening IS the direction.
  function makeRampGeometry(w, len, h) {
    const hw = w / 2, hl = len / 2;
    // entry edge at -Z (ground level), launch lip at +Z (height h)
    const tris = [
      // deck (slightly above ground so it doesn't z-fight)
      [-hw, 0.06, -hl], [hw, 0.06, -hl], [hw, h, hl],
      [-hw, 0.06, -hl], [hw, h, hl], [-hw, h, hl],
      // right side wall (solid wedge face)
      [hw, 0, -hl], [hw, 0, hl], [hw, h, hl],
      // left side wall
      [-hw, 0, -hl], [-hw, h, hl], [-hw, 0, hl],
      // back face under the lip
      [hw, 0, hl], [-hw, 0, hl], [-hw, h, hl],
      [hw, 0, hl], [-hw, h, hl], [hw, h, hl],
    ];
    const pos = new Float32Array(tris.length * 3);
    tris.forEach((v, i) => pos.set(v, i * 3));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    return geo;
  }

  const speedQuads = [];
  (function buildTrackFurniture() {
    for (const rp of S.RAMPS) {
      const grp = new THREE.Group();
      const gy = G.terrainHeight(rp.x, rp.z);
      grp.position.set(rp.x, gy, rp.z);
      grp.rotation.y = rp.heading;

      const wedge = new THREE.Mesh(
        makeRampGeometry(rp.w, rp.len, rp.h),
        new THREE.MeshStandardMaterial({
          color: 0x8b96a5, metalness: 0.55, roughness: 0.4,
          emissive: 0x2a3340, emissiveIntensity: 0.6, side: THREE.DoubleSide,
        })
      );
      wedge.castShadow = true; wedge.receiveShadow = true;
      grp.add(wedge);

      const slope = Math.atan2(rp.h, rp.len);
      // amber chevron stripes up the deck — readable from a distance
      for (let i = 0; i < 4; i++) {
        const tz = -rp.len / 2 + (i + 0.5) * (rp.len / 4);
        const ty = 0.1 + (tz + rp.len / 2) / rp.len * rp.h;
        const stripe = new THREE.Mesh(
          new THREE.BoxGeometry(rp.w - 0.6, 0.1, 0.55),
          new THREE.MeshBasicMaterial({ color: 0xffb347 })
        );
        stripe.rotation.x = -slope;
        stripe.position.set(0, ty + 0.06, tz);
        grp.add(stripe);
      }
      // glowing rails along both inclined edges
      for (const sx of [-(rp.w / 2 - 0.14), rp.w / 2 - 0.14]) {
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 1.0, rp.len * 1.02),
          new THREE.MeshStandardMaterial({ color: 0x39424d, metalness: 0.6, roughness: 0.5 })
        );
        wall.rotation.x = -slope;
        wall.position.set(sx, rp.h / 2 + 0.5, 0);
        wall.castShadow = true;
        grp.add(wall);
        const railGlow = new THREE.Mesh(
          new THREE.BoxGeometry(0.34, 0.12, rp.len * 1.02),
          new THREE.MeshBasicMaterial({ color: 0xffb347 })
        );
        railGlow.rotation.x = -slope;
        railGlow.position.set(sx, rp.h / 2 + 1.02, 0);
        grp.add(railGlow);
      }
      // glowing launch lip across the top edge
      const lip = new THREE.Mesh(
        new THREE.BoxGeometry(rp.w, 0.18, 0.35),
        new THREE.MeshBasicMaterial({ color: 0xffd76b })
      );
      lip.position.set(0, rp.h + 0.07, rp.len / 2 - 0.18);
      grp.add(lip);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: G.glowTex, color: 0xffb347, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.6,
      }));
      glow.scale.setScalar(11);
      glow.position.set(0, rp.h + 1.6, rp.len / 2 - 0.5);
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

  /* ---------------- wrong-way detector ----------------
     Driving away from the next gate at speed for >1 s flashes the
     WRONG WAY banner (the beacon beam on the cyan gate shows the way). */
  const elWrong = document.getElementById('wrongway');
  let wrongSince = 0;

  function updateGuidance(dt) {
    const st = G.state, r = G.rover;
    const racing = st.phase === 'race' && !st.finished && !(st.deadUntil > G.serverNow());
    if (!racing) { elWrong.classList.remove('show'); wrongSince = 0; return; }

    const g = GATES[st.nextGate];
    const dx = g.x - r.pos.x, dz = g.z - r.pos.z;

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

  /* ---------------- minimap: rotating moon globe ----------------
     The open world is shown as a sphere. World (x,z) maps to
     longitude/latitude on the moon; the globe is drawn in an
     orthographic projection centered on the vehicle, so it rotates
     under you as you drive. Only the facing hemisphere is visible.  */
  const mm = document.getElementById('minimap');
  const mctx = mm ? mm.getContext('2d') : null;
  const MMS = mm ? mm.width : 376;   // canvas backing-store px
  const K = MMS / 150;               // stroke/dot scale vs original 150px design
  const GR = MMS / 2 - 5 * K;        // globe radius on canvas
  const WRAP_L = S.WORLD.wrapHalf * 2;

  const lonOf = (x) => (x / WRAP_L) * S.TAU;
  const latOf = (z) => (z / WRAP_L) * Math.PI;

  // orthographic projection state (player-centered), updated per frame
  let _cL0 = 1, _sL0 = 0, _cA0 = 1, _sA0 = 0;
  function mmSetCenter(x, z) {
    const lon0 = lonOf(S.wrapCoord(x)), lat0 = latOf(S.wrapCoord(z));
    _cL0 = Math.cos(lon0); _sL0 = Math.sin(lon0);
    _cA0 = Math.cos(lat0); _sA0 = Math.sin(lat0);
  }
  // world → screen [sx, sy] or null when on the far hemisphere
  function mmProject(x, z) {
    const lon = lonOf(S.wrapCoord(x)), lat = latOf(S.wrapCoord(z));
    const cl = Math.cos(lat);
    const vx = cl * Math.sin(lon), vy = Math.sin(lat), vz = cl * Math.cos(lon);
    const x1 = vx * _cL0 - vz * _sL0;          // yaw the player's meridian to front
    const z1 = vx * _sL0 + vz * _cL0;
    const y2 = vy * _cA0 - z1 * _sA0;          // pitch the player's latitude to front
    const z2 = vy * _sA0 + z1 * _cA0;
    if (z2 < 0.04) return null;                // back of the moon
    return [MMS / 2 + x1 * GR, MMS / 2 - y2 * GR, z2];
  }
  // polyline on the globe: starts a new path across hidden gaps
  function mmPolyline(pts) {
    let pen = false;
    mctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = mmProject(pts[i][0], pts[i][1]);
      if (!p) { pen = false; continue; }
      pen ? mctx.lineTo(p[0], p[1]) : mctx.moveTo(p[0], p[1]);
      pen = true;
    }
    mctx.stroke();
  }
  function mmDot(x, z, r, style) {
    const p = mmProject(x, z);
    if (!p) return;
    mctx.fillStyle = style;
    mctx.beginPath(); mctx.arc(p[0], p[1], r * (0.6 + 0.4 * p[2]), 0, S.TAU); mctx.fill();
  }

  // static polylines: track ring + graticule (lat/lon grid for the globe feel)
  const TRACK_PTS = [];
  for (let i = 0; i <= 96; i++) {
    const a = (i / 96) * S.TAU, r = S.trackRadius(a);
    TRACK_PTS.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const GRID_PTS = [];
  for (let m = 0; m < 8; m++) {                       // meridians every 45°
    const x = (m / 8) * WRAP_L - S.WORLD.wrapHalf, line = [];
    for (let i = 0; i <= 40; i++) line.push([x, (i / 40) * WRAP_L - S.WORLD.wrapHalf]);
    GRID_PTS.push(line);
  }
  for (let q = 1; q < 6; q++) {                       // parallels every 30°
    const z = (q / 6) * WRAP_L - S.WORLD.wrapHalf, line = [];
    for (let i = 0; i <= 56; i++) line.push([(i / 56) * WRAP_L - S.WORLD.wrapHalf, z]);
    GRID_PTS.push(line);
  }

  let mmLast = 0;
  function drawMinimap(now) {
    if (!mctx || now - mmLast < 120) return;
    mmLast = now;
    mctx.clearRect(0, 0, MMS, MMS);

    const me = G.rover;
    mmSetCenter(me.pos.x, me.pos.z);

    // moon disc with a soft terminator shade + rim
    const cx = MMS / 2, cy = MMS / 2;
    const sh = mctx.createRadialGradient(cx - GR * 0.35, cy - GR * 0.35, GR * 0.15, cx, cy, GR);
    sh.addColorStop(0, 'rgba(64,70,78,0.92)');
    sh.addColorStop(0.75, 'rgba(36,40,46,0.94)');
    sh.addColorStop(1, 'rgba(18,20,24,0.96)');
    mctx.fillStyle = sh;
    mctx.beginPath(); mctx.arc(cx, cy, GR, 0, S.TAU); mctx.fill();
    mctx.strokeStyle = 'rgba(170,190,210,0.35)';
    mctx.lineWidth = 1 * K;
    mctx.beginPath(); mctx.arc(cx, cy, GR, 0, S.TAU); mctx.stroke();

    // graticule — makes the rotation readable
    mctx.strokeStyle = 'rgba(140,160,180,0.16)';
    mctx.lineWidth = 0.7 * K;
    for (const line of GRID_PTS) mmPolyline(line);

    // track ring
    mctx.strokeStyle = 'rgba(150,170,190,0.55)';
    mctx.lineWidth = 1.4 * K;
    mmPolyline(TRACK_PTS);

    // gates
    for (const g of GATES) {
      mmDot(g.x, g.z, (g.i === G.state.nextGate ? 3 : 2) * K,
        g.i === G.state.nextGate ? '#35e0ff' : 'rgba(255,179,71,0.85)');
    }

    // asteroid warnings
    if (G.asteroidWarnings) {
      for (const a of G.asteroidWarnings()) mmDot(a.x, a.z, 2.6 * K, 'rgba(255,70,60,0.85)');
    }

    // aliens (green blips)
    if (G.alienDots) {
      for (const a of G.alienDots()) mmDot(a.x, a.z, 2.4 * K, 'rgba(61,255,154,0.9)');
    }

    // remotes
    for (const r of G.remotes.values()) {
      mmDot(r.x, r.z, 2.6 * K, '#' + r.color.toString(16).padStart(6, '0'));
    }

    // me — always at the globe's center; arrow points along heading.
    // At the projection center, world +x (east) is screen-right and world +z
    // (north) is screen-up; forward = (sin h, cos h), so a canvas rotation of
    // exactly `heading` applied to an up-pointing arrow renders it correctly.
    mctx.save();
    mctx.translate(cx, cy);
    mctx.rotate(me.heading);
    mctx.fillStyle = '#ffffff';
    mctx.strokeStyle = 'rgba(0,0,0,0.55)';
    mctx.lineWidth = 1 * K;
    mctx.beginPath();
    mctx.moveTo(0, -4.6 * K); mctx.lineTo(3 * K, 3.2 * K); mctx.lineTo(-3 * K, 3.2 * K);
    mctx.closePath(); mctx.fill(); mctx.stroke();
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
