/* ================================================================
   ALIENS — client visuals for server-driven humanoid hostiles.
   Biped rig (glowing head, suit, rifle) that runs on the terrain,
   positions lerped toward the 15 Hz snapshot stream, leg-swing run
   cycle, faces its prey, claw-swipe beam on melee, pop + bounty
   feed on death. All behavior is server-authoritative; this module
   only renders.
   ================================================================ */
(function () {
  const S = SHARED, lerp = G.lerp;
  const aliens = new Map();   // id -> { grp, head, legs, arms, glow, x, z, tx, tz, yaw, hp, ph, runPh }

  function makeAlienRig() {
    const grp = new THREE.Group();
    const suit = new THREE.MeshStandardMaterial({ color: 0x3c4a42, metalness: 0.5, roughness: 0.55 });
    const skin = new THREE.MeshStandardMaterial({
      color: 0x49e88f, emissive: 0x1ec46a, emissiveIntensity: 1.4,
      metalness: 0.2, roughness: 0.4,
    });

    // legs (pivot at hip so they can swing)
    const legs = [];
    for (const sx of [-0.16, 0.16]) {
      const hip = new THREE.Group();
      hip.position.set(sx, 0.78, 0);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.07, 0.74, 8), suit);
      leg.position.y = -0.37;
      leg.castShadow = true;
      hip.add(leg);
      grp.add(hip);
      legs.push(hip);
    }
    // torso
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.62, 0.3), suit);
    torso.position.y = 1.1; torso.castShadow = true;
    grp.add(torso);
    // arms
    const arms = [];
    for (const sx of [-0.34, 0.34]) {
      const sh = new THREE.Group();
      sh.position.set(sx, 1.34, 0);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.58, 8), suit);
      arm.position.y = -0.29;
      arm.castShadow = true;
      sh.add(arm);
      grp.add(sh);
      arms.push(sh);
    }
    // rifle in the right hand, pointing forward
    const rifle = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.09, 0.62),
      new THREE.MeshStandardMaterial({ color: 0x222a26, metalness: 0.8, roughness: 0.3 })
    );
    rifle.position.set(0.34, 0.82, 0.28);
    grp.add(rifle);
    // oversized glowing head — the kill-me sign
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.27, 14, 12), skin);
    head.scale.y = 1.25;
    head.position.y = 1.78;
    head.castShadow = true;
    grp.add(head);
    // black almond eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x0a0f0c });
    for (const sx of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), eyeMat);
      eye.scale.set(1, 1.5, 0.5);
      eye.position.set(sx, 1.82, 0.22);
      grp.add(eye);
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: G.glowTex, color: 0x3dff9a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7,
    }));
    glow.scale.setScalar(4);
    glow.position.y = 1.78;
    grp.add(glow);
    return { grp, head, legs, arms, glow };
  }

  G.onAlienSpawn = function (m) {
    const rig = makeAlienRig();
    rig.grp.position.set(m.x, G.terrainHeight(m.x, m.z), m.z);
    G.scene.add(rig.grp);
    G.dustBurst(m.x, G.terrainHeight(m.x, m.z), m.z, 5);   // drop-pod puff
    aliens.set(m.id, {
      ...rig, x: m.x, z: m.z, tx: m.x, tz: m.z, yaw: 0,
      hp: m.hp, ph: Math.random() * S.TAU, runPh: 0,
    });
    if (G.hud) G.hud.feed('👽 hostile alien dropped in — kill it (F)');
    G.beep(180, 300, 'sawtooth', 0.06);
    G.beep(240, 300, 'sine', 0.05);
  };

  // 15 Hz snapshot stream: al = [[id, x, z, hp], ...]
  G.syncAliens = function (al) {
    const seen = new Set();
    for (const e of al) {
      const a = aliens.get(e[0]);
      seen.add(e[0]);
      if (a) { a.tx = e[1]; a.tz = e[2]; a.hp = e[3]; }
    }
    // drop anything the server no longer tracks (missed a gone/dead msg)
    for (const [id, a] of aliens) {
      if (!seen.has(id)) {
        a.ttl = (a.ttl || 0) + 1;
        if (a.ttl > 3) removeAlien(id);
      } else a.ttl = 0;
    }
  };

  G.onAlienHit = function (m) {
    const a = aliens.get(m.id);
    if (a) {
      a.hp = m.hp;
      G.dustBurst(a.x, G.terrainHeight(a.x, a.z) + 2.5, a.z, 2);
    }
    if (m.by === G.state.myId && G.hud) G.hud.hitConfirm(0, 'alien');
  };

  G.onAlienDead = function (m) {
    const a = aliens.get(m.id);
    if (a) {
      G.explosion(a.x, a.z, 1.4);
      removeAlien(m.id);
    }
    if (m.by === G.state.myId) {
      if (m.bounty && G.state.items.length < S.MAX_ITEMS) G.state.items.push(m.bounty);
      if (G.hud) G.hud.alert('👽 ALIEN DOWN' + (m.bounty ? ' — +' + S.ITEMS[m.bounty].name : ''), 2200);
      G.beep(660, 80, 'square', 0.07);
      setTimeout(() => G.beep(990, 120, 'square', 0.07), 90);
    } else if (G.hud) {
      const k = G.remotes.get(m.by);
      G.hud.feed('👽 alien downed' + (k ? ' by ' + k.name : ''));
    }
  };

  G.onAlienGone = function (m) { removeAlien(m.id); };

  /* melee claw-swipe beam: alien → target, fades fast */
  const beams = [];
  G.onAlienZap = function (m) {
    const a = aliens.get(m.id);
    if (!a) return;
    const tgt = m.target === G.state.myId ? G.rover.pos : G.remotes.get(m.target);
    if (!tgt) return;
    const y0 = G.terrainHeight(a.x, a.z) + 1.5;
    const y1 = (m.target === G.state.myId ? tgt.y : G.terrainHeight(tgt.x, tgt.z)) + 1.0;
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.x, y0, a.z),
      new THREE.Vector3(tgt.x, y1, tgt.z),
    ]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x4dff9f, transparent: true, opacity: 0.95,
    }));
    G.scene.add(line);
    beams.push({ line, t0: performance.now() });
    G.beep(1700, 90, 'sawtooth', 0.06);
    if (m.target === G.state.myId && G.hud) G.hud.feed('👽 alien zapped you');
  };

  function removeAlien(id) {
    const a = aliens.get(id);
    if (!a) return;
    G.scene.remove(a.grp);
    aliens.delete(id);
  }

  G.updateAliens = function (dt) {
    const t = performance.now() * 0.001;
    const k = 1 - Math.exp(-8 * dt);
    for (const a of aliens.values()) {
      const px = a.x, pz = a.z;
      a.x = lerp(a.x, a.tx, k);
      a.z = lerp(a.z, a.tz, k);
      a.grp.position.set(a.x, G.terrainHeight(a.x, a.z), a.z);

      // face the direction of travel; run cycle scales with speed
      const dx = a.x - px, dz = a.z - pz;
      const sp = Math.hypot(dx, dz) / Math.max(dt, 1e-3);
      if (sp > 0.5) {
        const want = Math.atan2(dx, dz);
        let dy = want - a.yaw;
        while (dy > Math.PI) dy -= S.TAU; while (dy < -Math.PI) dy += S.TAU;
        a.yaw += dy * Math.min(10 * dt, 1);
        a.grp.rotation.y = a.yaw;
      }
      a.runPh += Math.min(sp, S.ALIEN.speed) * 0.6 * dt;
      const swing = sp > 0.5 ? Math.sin(a.runPh * 6) * 0.6 : 0;
      a.legs[0].rotation.x = swing;
      a.legs[1].rotation.x = -swing;
      a.arms[0].rotation.x = -swing * 0.7;
      a.arms[1].rotation.x = swing * 0.7;

      a.glow.material.opacity = 0.5 + 0.25 * Math.sin(t * 5 + a.ph);
      // hurt aliens flicker
      if (a.hp < S.ALIEN.hp * 0.5) a.head.material.emissiveIntensity = 1 + Math.sin(t * 18) * 0.8;
    }
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      const u = (performance.now() - b.t0) / 280;
      if (u >= 1) {
        G.scene.remove(b.line); b.line.geometry.dispose(); b.line.material.dispose();
        beams.splice(i, 1);
      } else b.line.material.opacity = 0.95 * (1 - u);
    }
  };

  // minimap dots
  G.alienDots = function () {
    const out = [];
    for (const a of aliens.values()) out.push({ x: a.x, z: a.z });
    return out;
  };

  G.clearAliens = function () {
    for (const id of [...aliens.keys()]) removeAlien(id);
    for (const b of beams) { G.scene.remove(b.line); }
    beams.length = 0;
  };
})();
