/* ================================================================
   ALIENS — client visuals for server-driven alien hunters.
   Saucer rig (dome + hull ring + green glow), positions lerped
   toward the 15 Hz snapshot stream, hover bob, zap beam when one
   attacks, pop + bounty feed on death. All behavior is server-
   authoritative; this module only renders.
   ================================================================ */
(function () {
  const S = SHARED, lerp = G.lerp;
  const aliens = new Map();   // id -> { grp, dome, glow, x, z, tx, tz, hp, ph }

  function makeSaucer() {
    const grp = new THREE.Group();
    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.1, 0.5, 18),
      new THREE.MeshStandardMaterial({ color: 0x49545e, metalness: 0.85, roughness: 0.35 })
    );
    grp.add(hull);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(0.85, 16, 10, 0, S.TAU, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x2dff8f, emissive: 0x18c45f, emissiveIntensity: 1.6,
        transparent: true, opacity: 0.85, metalness: 0.2, roughness: 0.25,
      })
    );
    dome.position.y = 0.22;
    grp.add(dome);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: G.glowTex, color: 0x3dff9a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.8,
    }));
    glow.scale.setScalar(6);
    grp.add(glow);
    return { grp, dome, glow };
  }

  G.onAlienSpawn = function (m) {
    const rig = makeSaucer();
    rig.grp.position.set(m.x, G.terrainHeight(m.x, m.z) + 3.2, m.z);
    G.scene.add(rig.grp);
    aliens.set(m.id, {
      ...rig, x: m.x, z: m.z, tx: m.x, tz: m.z,
      hp: m.hp, ph: Math.random() * S.TAU,
    });
    if (G.hud) G.hud.feed('👽 alien inbound — blast it (F)');
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

  /* zap beam: alien → target, fades fast */
  const beams = [];
  G.onAlienZap = function (m) {
    const a = aliens.get(m.id);
    if (!a) return;
    const tgt = m.target === G.state.myId ? G.rover.pos : G.remotes.get(m.target);
    if (!tgt) return;
    const y0 = G.terrainHeight(a.x, a.z) + 3.2;
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
      a.x = lerp(a.x, a.tx, k);
      a.z = lerp(a.z, a.tz, k);
      const y = G.terrainHeight(a.x, a.z) + 3.2 + Math.sin(t * 2.2 + a.ph) * 0.5;
      a.grp.position.set(a.x, y, a.z);
      a.grp.rotation.y += 0.8 * dt;
      a.glow.material.opacity = 0.55 + 0.3 * Math.sin(t * 5 + a.ph);
      // hurt aliens flicker
      if (a.hp < S.ALIEN.hp * 0.5) a.dome.material.emissiveIntensity = 1 + Math.sin(t * 18) * 0.8;
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
