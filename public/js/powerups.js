/* ================================================================
   POWERUPS — weapon/energy crate visuals (floating glowing
   octahedra over fixed pods from SHARED.CRATES), pickup events,
   and the timed-effect fx events from the server (boost, shield,
   gravity stabilizer, repair, decoy, shield-break).
   Pickup VALIDATION is server-side; we only render and react.
   ================================================================ */
(function () {
  const S = SHARED;
  const crates = new Map();   // id -> { grp, core, glow, up, x, z, gy }

  (function build() {
    for (const c of S.CRATES) {
      const grp = new THREE.Group();
      const gy = G.terrainHeight(c.x, c.z);
      grp.position.set(c.x, gy, c.z);

      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.95, 0),
        new THREE.MeshStandardMaterial({
          color: 0x9adfff, emissive: 0x2e9fd0, emissiveIntensity: 1.4,
          metalness: 0.4, roughness: 0.3,
        })
      );
      core.position.y = 1.8;
      grp.add(core);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: G.glowTex, color: 0x6fd2ff, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7,
      }));
      glow.scale.setScalar(5);
      glow.position.y = 1.8;
      grp.add(glow);

      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.3, 26, 8, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x6fd2ff, transparent: true, opacity: 0.10,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        })
      );
      beam.position.y = 13;
      grp.add(beam);

      G.scene.add(grp);
      crates.set(c.id, { grp, core, glow, up: true, x: c.x, z: c.z, gy, ph: Math.random() * S.TAU });
    }
  })();

  G.setCrates = function (list) {     // from joined payload
    for (const c of list) {
      const o = crates.get(c.id);
      if (o) { o.up = c.up; o.grp.visible = c.up; }
    }
  };

  G.onCrateTaken = function (m) {
    const o = crates.get(m.id);
    if (o) {
      o.up = false; o.grp.visible = false;
      G.dustBurst(o.x, o.gy, o.z, 2.5);
    }
    if (m.by === G.state.myId) {
      const st = G.state;
      if (st.items.length < S.MAX_ITEMS) st.items.push(m.item);
      const it = S.ITEMS[m.item];
      if (G.hud) G.hud.feed('▣ + ' + it.name + '  [' + st.items.length + '/' + S.MAX_ITEMS + ']');
      G.beep(660, 90, 'triangle', 0.07);
      setTimeout(() => G.beep(990, 120, 'triangle', 0.07), 100);
    }
  };

  G.onCrateUp = function (m) {
    const o = crates.get(m.id);
    if (o) { o.up = true; o.grp.visible = true; }
  };

  /* item use → just tell the server; it validates cooldown + inventory */
  let lastUse = 0;
  G.useItem = function () {
    const st = G.state;
    const now = performance.now();
    st.itemSel = Math.min(st.itemSel, Math.max(st.items.length - 1, 0));
    if (!st.items.length || now - lastUse < 200) return;
    if (st.phase !== 'race' || st.controlsLocked) return;
    lastUse = now;
    G.net.send({ t: 'use', slot: st.itemSel });
  };

  G.cycleItem = function (dir) {
    const st = G.state;
    if (st.items.length < 2) return;
    st.itemSel = (st.itemSel + (dir || 1) + st.items.length) % st.items.length;
    G.beep(440, 40, 'square', 0.04);
  };

  G.selectItem = function (i) {
    const st = G.state;
    if (i < st.items.length) { st.itemSel = i; G.beep(440, 40, 'square', 0.04); }
  };

  G.onItemUsed = function (m) {
    if (m.id === G.state.myId) {
      const st = G.state;
      st.items.splice(Math.min(m.slot | 0, st.items.length - 1), 1);
      st.itemSel = Math.min(st.itemSel, Math.max(st.items.length - 1, 0));
      G.beep(520, 80, 'square', 0.05);
    }
  };

  /* EMP loot steal */
  G.onItemStolen = function (m) {
    const st = G.state;
    if (m.from === st.myId) {
      st.items.pop();
      st.itemSel = Math.min(st.itemSel, Math.max(st.items.length - 1, 0));
      if (G.hud) G.hud.alert('⌁ ITEM STOLEN — ' + S.ITEMS[m.item].name);
      G.beep(220, 250, 'sawtooth', 0.07);
    } else if (m.to === st.myId) {
      if (st.items.length < S.MAX_ITEMS) st.items.push(m.item);
      if (G.hud) G.hud.feed('⌁ stole ' + S.ITEMS[m.item].name);
      G.beep(880, 90, 'triangle', 0.06);
    } else if (G.hud) {
      const f = G.remotes.get(m.from), to = G.remotes.get(m.to);
      G.hud.feed('⌁ ' + (to ? to.name : '?') + ' stole ' + S.ITEMS[m.item].name + ' from ' + (f ? f.name : '?'));
    }
  };

  /* timed effects pushed by the server */
  G.onFx = function (m) {
    const me = m.id === G.state.myId;
    switch (m.kind) {
      case 'boost':
        if (me) { G.state.boostUntil = m.until; G.beep(330, 70, 'sawtooth', 0.06); G.beep(660, 200, 'sawtooth', 0.05); }
        break;
      case 'shield':
        if (me) { G.state.shieldUntil = m.until; G.beep(740, 160, 'sine', 0.06); }
        break;
      case 'gstab':
        if (me) { G.state.gstabUntil = m.until; G.beep(280, 160, 'sine', 0.06); }
        break;
      case 'repair':
        if (me) { G.state.hp = m.hp; G.beep(880, 80, 'sine', 0.05); G.beep(1170, 140, 'sine', 0.05); }
        break;
      case 'decoy': {
        if (me) G.state.decoyUntil = m.until;
        // bright flare behind whoever popped it
        const src = me ? G.rover.pos : G.remotes.get(m.id);
        if (src) {
          const x = me ? src.x : src.x, z = me ? src.z : src.z;
          const y = G.terrainHeight(x, z);
          for (let i = 0; i < 14; i++) {
            G.spawnDust(x, y + 1.2, z,
              (Math.random() - 0.5) * 5, 2 + Math.random() * 4, (Math.random() - 0.5) * 5,
              0.3, 1.4, 0.85, y - 1);
          }
        }
        break;
      }
      case 'shieldBreak': {
        if (me) { G.state.shieldUntil = 0; G.boom(0.08); }
        const r = G.remotes.get(m.id);
        const p = me ? G.rover.pos : r;
        if (p) G.dustBurst(p.x, me ? p.y : G.terrainHeight(p.x, p.z), p.z, 4);
        if (G.hud) G.hud.feed(me ? 'YOUR SHIELD BROKE' : 'shield broken');
        break;
      }
    }
  };

  G.updateCrates = function (dt) {
    const t = performance.now() * 0.001;
    for (const o of crates.values()) {
      if (!o.up) continue;
      o.core.position.y = 1.8 + Math.sin(t * 1.8 + o.ph) * 0.3;
      o.core.rotation.y += 1.4 * dt;
      o.glow.material.opacity = 0.55 + 0.25 * Math.sin(t * 2.4 + o.ph);
    }
  };
})();
