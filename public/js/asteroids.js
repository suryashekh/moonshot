/* ================================================================
   ASTEROIDS — client visuals for the server's asteroid scheduler.
   astSpawn → warning ring conformed to terrain (yellow → red as
   impact nears) + a rock falling on a timed trajectory so it
   lands exactly at impactTs. astBoom → explosion, scorch decal,
   knockback if I'm in the hit list. astKilled → mid-air pop
   (shot down by a straight rocket).
   ================================================================ */
(function () {
  const S = SHARED;
  const live = new Map();   // id -> ast

  const FALL_MS = 3200;     // visual fall duration (≤ warning lead given by server)

  function makeWarnRing(x, z) {
    const SEG = 40, R = S.DMG.asteroidShockR;
    const pts = [];
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * S.TAU;
      const px = x + Math.cos(a) * R, pz = z + Math.sin(a) * R;
      pts.push(new THREE.Vector3(px, G.terrainHeight(px, pz) + 0.35, pz));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const ring = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
      color: 0xffe04a, transparent: true, opacity: 0.9,
    }));
    // inner fill disc for readability from the cockpit
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(R, 36),
      new THREE.MeshBasicMaterial({
        color: 0xff5040, transparent: true, opacity: 0.05,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, G.terrainHeight(x, z) + 0.2, z);
    G.scene.add(ring); G.scene.add(disc);
    return { ring, disc };
  }

  G.onAstSpawn = function (m) {
    const { ring, disc } = makeWarnRing(m.x, m.z);
    const size = m.big ? 2.2 : 1.1;
    const rock = new THREE.Mesh(G.makeRockGeometry(1, m.id * 7 + 13), G.rockMat);
    rock.scale.setScalar(size);
    rock.visible = false;
    G.scene.add(rock);

    live.set(m.id, {
      id: m.id, x: m.x, z: m.z, impactTs: m.impactTs, big: m.big,
      mine: m.target === G.state.myId,   // locked onto MY rover
      ring, disc, rock, size,
      gy: G.terrainHeight(m.x, m.z),
      startY: 150 + Math.random() * 40,
      driftA: Math.random() * S.TAU,
    });
  };

  G.onAstBoom = function (m) {
    const a = live.get(m.id);
    if (a) dispose(a);
    G.explosion(m.x, m.z, m.big ? 2.6 : 1.5);
    if (G.addCamShake) {
      const d = Math.hypot(G.rover.pos.x - m.x, G.rover.pos.z - m.z);
      G.addCamShake(Math.max(0, 0.5 - d / 120));
    }
  };

  G.onAstKilled = function (m) {
    const a = live.get(m.id);
    if (a) {
      // pop in mid-air at the rock's current position
      const p = a.rock.position;
      G.explosion(p.x, p.z, 0.9);
      dispose(a);
    }
  };

  function dispose(a) {
    G.scene.remove(a.ring); G.scene.remove(a.disc); G.scene.remove(a.rock);
    a.ring.geometry.dispose(); a.ring.material.dispose();
    a.disc.geometry.dispose(); a.disc.material.dispose();
    live.delete(a.id);
  }

  G.updateAsteroids = function (dt) {
    const sNow = G.serverNow();
    for (const a of live.values()) {
      const tLeft = a.impactTs - sNow;

      // warning ring: yellow → red pulse, faster as impact nears;
      // rocks locked on ME start hot so the threat reads instantly
      let u = G.clamp(1 - tLeft / 5000, 0, 1);
      if (a.mine) u = Math.max(u, 0.65);
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() * (0.006 + u * 0.02));
      a.ring.material.color.setRGB(1, 0.88 - 0.7 * u, 0.3 - 0.25 * u);
      a.ring.material.opacity = pulse;
      a.disc.material.opacity = 0.04 + u * 0.12 * pulse;

      // falling rock, timed so y reaches ground at impactTs
      if (tLeft <= FALL_MS) {
        a.rock.visible = true;
        const k = G.clamp(1 - tLeft / FALL_MS, 0, 1);       // 0 → 1
        const y = a.startY + (a.gy - a.startY) * (k * k);   // accelerating fall
        a.rock.position.set(
          a.x + Math.cos(a.driftA) * (1 - k) * 14,
          y,
          a.z + Math.sin(a.driftA) * (1 - k) * 14
        );
        a.rock.rotation.x += 2.4 * dt;
        a.rock.rotation.y += 1.7 * dt;
        // fiery trail
        if (Math.random() < dt * 30) {
          G.spawnDust(a.rock.position.x, a.rock.position.y, a.rock.position.z,
            (Math.random() - 0.5) * 2, 1 + Math.random() * 2, (Math.random() - 0.5) * 2,
            0.25 * a.size, 0.8, 0.5, -1000);
        }
      }
      // server cleanup is authoritative; local timeout guard:
      if (tLeft < -1500) dispose(a);
    }
  };

  // for the minimap
  G.asteroidWarnings = function () {
    const out = [];
    for (const a of live.values()) out.push({ x: a.x, z: a.z });
    return out;
  };

  G.clearAsteroids = function () {
    for (const a of [...live.values()]) dispose(a);
  };
})();
