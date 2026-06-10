/* ================================================================
   COMBAT — client visuals for server-simulated weapons.
   Rockets fly locally from their spawn params and are nudged by
   the server's 15 Hz `pr` corrections in each snapshot; mines and
   gravity traps are static props; EMP renders an expanding ring.
   All hits/damage arrive as server messages — nothing here deals
   damage by itself.
   ================================================================ */
(function () {
  const S = SHARED, lerp = G.lerp;

  /* ---------------- rockets ---------------- */
  const rockets = new Map();   // id -> { mesh, x, z, yaw, speed, kind }

  function makeRocketMesh(kind) {
    const grp = new THREE.Group();
    if (kind === 'blast' || kind === 'abolt') {   // tracer bolt: cyan (mine) / green (alien)
      const col = kind === 'abolt' ? 0x4dff8f : 0x8df3ff;
      const bolt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.09, 0.09, 1.6, 6),
        new THREE.MeshBasicMaterial({ color: col })
      );
      bolt.rotation.x = Math.PI / 2;
      grp.add(bolt);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: G.glowTex, color: col,
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.setScalar(1.6);
      grp.add(glow);
      return grp;
    }
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 1.1, 8),
      new THREE.MeshStandardMaterial({
        color: kind === 'hrocket' ? 0xff6b9e : 0xd8dde2,
        emissive: kind === 'hrocket' ? 0xff2050 : 0xff8030,
        emissiveIntensity: 0.8, metalness: 0.6, roughness: 0.4,
      })
    );
    body.rotation.x = Math.PI / 2;     // axis → +Z (forward)
    grp.add(body);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: G.glowTex, color: kind === 'hrocket' ? 0xff5070 : 0xffb060,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    glow.scale.setScalar(2.4);
    glow.position.z = -0.7;
    grp.add(glow);
    return grp;
  }

  G.onRocket = function (m) {
    const mesh = makeRocketMesh(m.kind);
    G.scene.add(mesh);
    rockets.set(m.id, { mesh, x: m.x, z: m.z, yaw: m.yaw, speed: m.speed, kind: m.kind });
    if (m.kind === 'blast') G.beep(1300, 60, 'square', 0.045);
    else if (m.kind === 'abolt') G.beep(700, 110, 'sawtooth', 0.05);
    else G.beep(m.kind === 'hrocket' ? 220 : 180, 180, 'sawtooth', 0.06);
  };

  /* ---------------- pulse blaster (mine) ---------------- */
  G.gun = { shots: S.GUN.shots, rechargeAt: 0, lastFire: 0 };
  G.fireGun = function () {
    const st = G.state, now = performance.now();
    if (st.phase !== 'race' || st.controlsLocked || st.finished) return;
    if (now - G.gun.lastFire < S.GUN.fireGapMs - 30) return;
    if (G.gun.shots <= 0 && G.serverNow() < G.gun.rechargeAt) {
      G.beep(160, 60, 'square', 0.03);   // dry click
      return;
    }
    G.gun.lastFire = now;
    G.net.send({ t: 'gun' });
  };
  G.onAmmo = function (m) {
    G.gun.shots = m.shots;
    if (m.rechargeAt) {
      G.gun.rechargeAt = m.rechargeAt;
      G.beep(300, 160, 'sine', 0.05);    // mag empty
    }
  };
  G.resetGun = function () {
    G.gun.shots = S.GUN.shots;
    G.gun.rechargeAt = 0;
  };

  /* ---------------- turbo (same model as the blaster) ---------------- */
  G.turbo = { charges: S.TURBO.charges, rechargeAt: 0, lastUse: 0 };
  G.fireTurbo = function () {
    const st = G.state, now = performance.now();
    if (st.phase !== 'race' || st.controlsLocked || st.finished) return;
    if (now - G.turbo.lastUse < S.TURBO.useGapMs - 30) return;
    if (G.turbo.charges <= 0 && G.serverNow() < G.turbo.rechargeAt) {
      G.beep(160, 60, 'square', 0.03);   // dry click
      return;
    }
    G.turbo.lastUse = now;
    G.net.send({ t: 'turbo' });
  };
  G.onTurboAmmo = function (m) {
    G.turbo.charges = m.charges;
    if (m.rechargeAt) {
      G.turbo.rechargeAt = m.rechargeAt;
      G.beep(260, 180, 'sine', 0.05);    // tank empty
    }
  };
  G.resetTurbo = function () {
    G.turbo.charges = S.TURBO.charges;
    G.turbo.rechargeAt = 0;
  };

  G.onRocketBoom = function (m) {
    const r = rockets.get(m.id);
    if (r) { G.scene.remove(r.mesh); rockets.delete(m.id); }
    G.explosion(m.x, m.z, 1.3);
  };

  // snapshot corrections: pr = [[id, x, z, yaw], ...]
  G.syncRockets = function (pr) {
    const seen = new Set();
    for (const e of pr) {
      const r = rockets.get(e[0]);
      seen.add(e[0]);
      if (r) {
        // gentle pull toward authoritative pose
        r.x = lerp(r.x, e[1], 0.5);
        r.z = lerp(r.z, e[2], 0.5);
        r.yaw = e[3];
      }
    }
    // any rocket the server no longer tracks but never boomed → drop quietly
    for (const [id, r] of rockets) {
      if (!seen.has(id) && pr.length >= 0) {
        r.ttl = (r.ttl || 0) + 1;
        if (r.ttl > 3) { G.scene.remove(r.mesh); rockets.delete(id); }
      } else r.ttl = 0;
    }
  };

  function updateRockets(dt) {
    for (const r of rockets.values()) {
      r.x += Math.sin(r.yaw) * r.speed * dt;
      r.z += Math.cos(r.yaw) * r.speed * dt;
      const y = G.terrainHeight(r.x, r.z) + 1.4;
      r.mesh.position.set(r.x, y, r.z);
      r.mesh.rotation.y = r.yaw;
      // exhaust (tracer bolts fly clean)
      if (r.kind !== 'blast' && r.kind !== 'abolt' && Math.random() < dt * 40) {
        G.spawnDust(r.x - Math.sin(r.yaw) * 0.8, y, r.z - Math.cos(r.yaw) * 0.8,
          (Math.random() - 0.5) * 1.5, 0.5 + Math.random(), (Math.random() - 0.5) * 1.5,
          0.14, 0.6, 0.55, -1000);
      }
    }
  }

  /* ---------------- mines ---------------- */
  const mines = new Map();
  G.onMine = function (m) {
    const grp = new THREE.Group();
    const gy = G.terrainHeight(m.x, m.z);
    grp.position.set(m.x, gy, m.z);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.7, 0.28, 12),
      new THREE.MeshStandardMaterial({ color: 0x44474d, metalness: 0.7, roughness: 0.45 })
    );
    disc.position.y = 0.14;
    grp.add(disc);
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3030 })
    );
    light.position.y = 0.34;
    grp.add(light);
    G.scene.add(grp);
    mines.set(m.id, { grp, light, owner: m.owner });
  };
  G.onMineGone = function (m) {
    const o = mines.get(m.id);
    if (o) { G.scene.remove(o.grp); mines.delete(m.id); }
  };
  G.onMineBoom = function (m) {
    G.onMineGone(m);
    G.explosion(m.x, m.z, 1.1);
  };

  /* ---------------- gravity traps ---------------- */
  const traps = new Map();
  G.onTrap = function (m) {
    const gy = G.terrainHeight(m.x, m.z);
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(m.r, 28),
      new THREE.MeshBasicMaterial({
        color: 0xb070ff, transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(m.x, gy + 0.25, m.z);
    G.scene.add(disc);
    traps.set(m.id, { disc, x: m.x, z: m.z, r: m.r, owner: m.owner });
  };
  G.onTrapGone = function (m) {
    const o = traps.get(m.id);
    if (o) { G.scene.remove(o.disc); traps.delete(m.id); }
  };

  // queried by local physics: am I standing in an enemy trap?
  G.trapGripAt = function (x, z) {
    for (const t of traps.values()) {
      if (t.owner === G.state.myId) continue;
      const dx = x - t.x, dz = z - t.z;
      if (dx * dx + dz * dz < t.r * t.r) return true;
    }
    return false;
  };

  /* ---------------- EMP blast ---------------- */
  G.onEmpBlast = function (m) {
    const gy = G.terrainHeight(m.x, m.z);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1.0, 48),
      new THREE.MeshBasicMaterial({
        color: 0x77e8ff, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(m.x, gy + 0.4, m.z);
    G.scene.add(ring);
    const t0 = performance.now();
    (function anim() {
      const k = (performance.now() - t0) / 600;
      if (k >= 1) {
        G.scene.remove(ring); ring.geometry.dispose(); ring.material.dispose();
        return;
      }
      const r = 1 + k * m.r;
      ring.scale.set(r, r, 1);
      ring.material.opacity = 0.9 * (1 - k);
      requestAnimationFrame(anim);
    })();
    G.beep(95, 380, 'sawtooth', 0.09);

    if (m.victims && m.victims.includes(G.state.myId)) {
      G.state.empUntil = G.serverNow() + S.COMBAT.empImpairMs;
      if (G.hud) G.hud.empHit(S.COMBAT.empImpairMs);
      // headlight flicker
      let n = 0;
      const iv = setInterval(() => {
        G.myRig.setLights(n % 2 === 0);
        if (++n > 7) { clearInterval(iv); G.myRig.setLights(false); }
      }, 120);
    }
  };

  /* ---------------- lock-on / meteor warning ---------------- */
  G.onLockOn = function () {
    if (G.hud) G.hud.lockOn();
    G.beep(1400, 120, 'square', 0.08);
    setTimeout(() => G.beep(1400, 120, 'square', 0.08), 200);
    setTimeout(() => G.beep(1400, 120, 'square', 0.08), 400);
  };

  G.onMeteorWarn = function (m) {
    if (G.hud) G.hud.feed('☄ METEOR STRIKE INBOUND');
    G.beep(160, 600, 'sawtooth', 0.09);
  };

  G.updateCombat = function (dt) {
    updateRockets(dt);
    const blink = performance.now() % 800 < 400;
    for (const m of mines.values()) m.light.visible = blink;
    const t = performance.now() * 0.002;
    for (const tr of traps.values()) tr.disc.material.opacity = 0.13 + 0.07 * Math.sin(t * 3);
  };

  G.clearCombat = function () {
    for (const r of rockets.values()) G.scene.remove(r.mesh);
    rockets.clear();
    for (const m of mines.values()) G.scene.remove(m.grp);
    mines.clear();
    for (const tr of traps.values()) G.scene.remove(tr.disc);
    traps.clear();
  };
})();
