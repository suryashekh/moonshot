/* ================================================================
   DUST — ballistic regolith particle pool (ported verbatim from
   the base sim), generalized so ANY entity (local rover, remote
   rovers, rockets, asteroids) can emit. Also hosts explosion FX:
   flash sprites, expanding shockwave rings and debris rocks.
   ================================================================ */
(function () {
  const CFG = G.CFG, clamp = G.clamp;

  const DUST_N = CFG.dustCount;
  const dustPos     = new Float32Array(DUST_N * 3);
  const dustVel     = new Float32Array(DUST_N * 3);
  const dustLife    = new Float32Array(DUST_N);
  const dustMaxLife = new Float32Array(DUST_N);
  const dustFloor   = new Float32Array(DUST_N);
  const dustBaseA   = new Float32Array(DUST_N);
  const dustAlpha   = new Float32Array(DUST_N);
  const dustSize    = new Float32Array(DUST_N);
  for (let i = 0; i < DUST_N; i++) dustPos[i * 3 + 1] = -1000;

  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aAlpha',   new THREE.BufferAttribute(dustAlpha, 1));
  dustGeo.setAttribute('aSize',    new THREE.BufferAttribute(dustSize, 1));

  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uScale: { value: 700 },
      uColor: { value: new THREE.Color(0.67, 0.65, 0.61) },
    },
    vertexShader: [
      'attribute float aSize;',
      'attribute float aAlpha;',
      'uniform float uScale;',
      'varying float vAlpha;',
      'void main(){',
      '  vAlpha = aAlpha;',
      '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
      '  gl_PointSize = aSize * uScale / max(0.5, -mv.z);',
      '  gl_Position = projectionMatrix * mv;',
      '}',
    ].join('\n'),
    fragmentShader: [
      'uniform vec3 uColor;',
      'varying float vAlpha;',
      'void main(){',
      '  float d = length(gl_PointCoord - 0.5);',
      '  float a = smoothstep(0.5, 0.12, d) * vAlpha;',
      '  if (a < 0.012) discard;',
      '  gl_FragColor = vec4(uColor, a);',
      '}',
    ].join('\n'),
    transparent: true,
    depthWrite: false,
  });

  const dustPoints = new THREE.Points(dustGeo, dustMat);
  dustPoints.frustumCulled = false;
  G.scene.add(dustPoints);

  let dustHead = 0;
  function spawnDust(x, y, z, vx, vy, vz, size, life, alpha, floorY) {
    const i = dustHead;
    dustHead = (dustHead + 1) % DUST_N;
    dustPos[i * 3] = x; dustPos[i * 3 + 1] = y; dustPos[i * 3 + 2] = z;
    dustVel[i * 3] = vx; dustVel[i * 3 + 1] = vy; dustVel[i * 3 + 2] = vz;
    dustLife[i] = dustMaxLife[i] = life;
    dustSize[i] = size;
    dustBaseA[i] = alpha;
    dustAlpha[i] = 0;
    dustFloor[i] = floorY;
  }

  function updateDust(dt) {
    for (let i = 0; i < DUST_N; i++) {
      if (dustLife[i] <= 0) continue;
      dustLife[i] -= dt;
      if (dustLife[i] <= 0) { dustAlpha[i] = 0; dustPos[i * 3 + 1] = -1000; continue; }
      dustVel[i * 3 + 1] -= CFG.gravity * dt;            // lunar gravity, no drag (vacuum)
      dustPos[i * 3]     += dustVel[i * 3] * dt;
      dustPos[i * 3 + 1] += dustVel[i * 3 + 1] * dt;
      dustPos[i * 3 + 2] += dustVel[i * 3 + 2] * dt;
      if (dustPos[i * 3 + 1] < dustFloor[i]) {           // grain re-enters the regolith
        dustLife[i] = 0; dustAlpha[i] = 0; dustPos[i * 3 + 1] = -1000; continue;
      }
      const t = dustLife[i] / dustMaxLife[i];            // 1 -> 0
      dustAlpha[i] = dustBaseA[i] * Math.min(1, (1 - t) * 8) * Math.min(1, t * 3);
    }
    dustGeo.attributes.position.needsUpdate = true;
    dustGeo.attributes.aAlpha.needsUpdate = true;
    dustGeo.attributes.aSize.needsUpdate = true;
  }

  /* Generic wheel rooster tails for any rover-like entity.
     ent = { x,y,z, vx,vz, vL, grounded, braking, dustAccum } */
  function emitWheelDustFor(ent, wheelWorld, dt, scale) {
    if (!ent.grounded) return;
    const hSpeed = Math.hypot(ent.vx, ent.vz);
    const skid = clamp(Math.abs(ent.vL) / 3.5, 0, 1);
    if (hSpeed < 1.2 && skid < 0.2) return;

    ent.dustAccum = (ent.dustAccum || 0) +
      (hSpeed * 1.5 + skid * 22 + (ent.braking ? 8 : 0)) * dt * (scale || 1);
    let count = Math.min(Math.floor(ent.dustAccum), 14);
    ent.dustAccum -= count;

    const inv = 1 / Math.max(hSpeed, 0.001);
    const tx = ent.vx * inv, tz = ent.vz * inv;
    for (let c = 0; c < count; c++) {
      const w = (Math.random() * wheelWorld.length) | 0;
      const ww = wheelWorld[w];
      spawnDust(
        ww.x - tx * 0.35 + (Math.random() - 0.5) * 0.3,
        ww.y + 0.10,
        ww.z - tz * 0.35 + (Math.random() - 0.5) * 0.3,
        -tx * hSpeed * (0.25 + Math.random() * 0.3) + (Math.random() - 0.5) * 1.2,
        0.8 + Math.random() * 2.6,
        -tz * hSpeed * (0.25 + Math.random() * 0.3) + (Math.random() - 0.5) * 1.2,
        0.07 + Math.random() * 0.13,
        1.6 + Math.random() * 2.4,
        0.45 + skid * 0.4,
        ww.y - 0.1
      );
    }
  }

  // Radial dust burst at a world point (landings, explosions)
  function dustBurst(x, y, z, strength) {
    const s = Math.min(strength, 9);
    const count = Math.min(20 + s * 8, 90) | 0;
    for (let c = 0; c < count; c++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.8 + Math.random() * 0.6) * s * 0.45;
      spawnDust(
        x + Math.cos(a) * 1.1, y + 0.12, z + Math.sin(a) * 1.1,
        Math.cos(a) * sp, 0.4 + Math.random() * 0.25 * s, Math.sin(a) * sp,
        0.09 + Math.random() * 0.16, 1.5 + Math.random() * 2.0, 0.55, y - 0.15
      );
    }
  }

  /* ---------------- explosion FX ----------------
     flash sprite + expanding ground ring + ballistic debris
     + big dust plume. size ~1 (mine) .. ~3 (big asteroid).  */
  const fx = [];   // { mesh, kind, t, life, ... }

  const flashMat = new THREE.SpriteMaterial({
    map: G.glowTex, color: 0xffd9a0, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ringGeo = new THREE.RingGeometry(0.92, 1.0, 48);

  /* billowing plume blobs: a few cached lumpy spheres (displaced icosa)
     reused by every explosion — yellow core → orange lobes → smoke tips */
  const blobGeos = (function () {
    const out = [];
    for (let v = 0; v < 3; v++) {
      const g = new THREE.IcosahedronGeometry(1, 1);
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const k = 1 + (Math.random() - 0.5) * 0.42;
        pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
      }
      g.computeVertexNormals();
      out.push(g);
    }
    return out;
  })();
  const PLUME_COLORS = [
    { c: 0xffe27a, e: 0xffc23d, ei: 1.6 },   // glowing core / base
    { c: 0xff8a30, e: 0xff5a1a, ei: 0.9 },   // fire mid
    { c: 0x9094a0, e: 0x2c2f38, ei: 0.25 },  // smoke tip
  ];

  function explosion(x, z, size) {
    const y = G.terrainHeight(x, z);
    size = size || 1;

    // flash
    const sp = new THREE.Sprite(flashMat.clone());
    sp.position.set(x, y + 1.6 * size, z);
    sp.scale.setScalar(1);
    G.scene.add(sp);
    fx.push({ mesh: sp, kind: 'flash', t: 0, life: 0.38, size: 8 * size });

    // shockwave ring laid on the ground
    const rm = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xffc890, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    rm.rotation.x = -Math.PI / 2;
    rm.position.set(x, y + 0.25, z);
    G.scene.add(rm);
    fx.push({ mesh: rm, kind: 'ring', t: 0, life: 0.9, size: 16 * size });

    // billowing plume sculpture: glowing core + lobed columns fanning
    // up and outward, yellow → orange → smoke-grey toward the tips
    {
      const grp = new THREE.Group();
      grp.position.set(x, y + 0.2, z);
      const mats = PLUME_COLORS.map(p => new THREE.MeshStandardMaterial({
        color: p.c, emissive: p.e, emissiveIntensity: p.ei,
        roughness: 0.85, metalness: 0, transparent: true, opacity: 1,
      }));
      const blobs = [];
      const core = new THREE.Mesh(blobGeos[(Math.random() * 3) | 0], mats[0]);
      core.scale.setScalar(1.15 * size);
      core.position.y = 0.7 * size;
      grp.add(core);
      blobs.push({ m: core, tx: 0, ty: 0.7 * size, tz: 0 });

      const nPlumes = Math.min(6 + (size * 2) | 0, 10);
      for (let p = 0; p < nPlumes; p++) {
        const az = (p / nPlumes) * Math.PI * 2 + Math.random() * 0.5;
        const el = 0.55 + Math.random() * 0.75;              // mostly upward fan
        const dx = Math.cos(az) * Math.cos(el), dy = Math.sin(el), dz = Math.sin(az) * Math.cos(el);
        const len = (2.4 + Math.random() * 1.4) * size;
        const segs = 3 + (Math.random() * 2) | 0;
        for (let s = 0; s < segs; s++) {
          const f = (s + 1) / segs;
          const mat = mats[f < 0.45 ? 0 : f < 0.8 ? 1 : 2];
          const b = new THREE.Mesh(blobGeos[(Math.random() * 3) | 0], mat);
          b.scale.setScalar((0.85 - f * 0.45) * size * (0.8 + Math.random() * 0.3));
          const jx = (Math.random() - 0.5) * 0.4 * size, jz = (Math.random() - 0.5) * 0.4 * size;
          grp.add(b);
          blobs.push({ m: b, tx: dx * len * f + jx, ty: dy * len * f + 0.4 * size, tz: dz * len * f + jz });
        }
      }
      // start collapsed at the core; updateFx expands toward targets
      for (const b of blobs) b.m.position.set(b.tx * 0.15, b.ty * 0.25, b.tz * 0.15);
      G.scene.add(grp);
      fx.push({ mesh: grp, kind: 'plume', t: 0, life: 1.05, blobs, mats, size });
    }

    // debris rocks on ballistic arcs
    const n = (5 + size * 4) | 0;
    for (let i = 0; i < n; i++) {
      const g = G.makeRockGeometry(0, (Math.random() * 1e6) | 0);
      const m = new THREE.Mesh(g, G.rockMat);
      const s = 0.12 + Math.random() * 0.25 * size;
      m.scale.setScalar(s);
      m.position.set(x, y + 0.5, z);
      const a = Math.random() * Math.PI * 2;
      const sp2 = (3 + Math.random() * 6) * Math.sqrt(size);
      G.scene.add(m);
      fx.push({
        mesh: m, kind: 'debris', t: 0, life: 2.6 + Math.random(),
        vx: Math.cos(a) * sp2, vy: 4 + Math.random() * 5 * size, vz: Math.sin(a) * sp2,
        rx: Math.random() * 6 - 3, rz: Math.random() * 6 - 3,
      });
    }

    // dust plume — taller and denser than a landing puff
    const count = Math.min(30 + size * 35, 120) | 0;
    for (let c = 0; c < count; c++) {
      const a = Math.random() * Math.PI * 2;
      const r0 = Math.random() * 1.6 * size;
      const sp3 = (1.5 + Math.random() * 2.5) * size;
      spawnDust(
        x + Math.cos(a) * r0, y + 0.3, z + Math.sin(a) * r0,
        Math.cos(a) * sp3, 2.5 + Math.random() * 4.5 * size, Math.sin(a) * sp3,
        0.12 + Math.random() * 0.22, 2.2 + Math.random() * 2.5, 0.6, y - 0.2
      );
    }

    G.paintScorch(x, z, 3.2 * size, 0.5);
    G.boom(0.10 + 0.05 * size);
  }

  function updateFx(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const e = fx[i];
      e.t += dt;
      const k = e.t / e.life;
      if (k >= 1) {
        G.scene.remove(e.mesh);
        if (e.mats) for (const m of e.mats) m.dispose();
        else if (e.mesh.material && e.mesh.material !== G.rockMat) e.mesh.material.dispose();
        fx.splice(i, 1);
        continue;
      }
      if (e.kind === 'flash') {
        e.mesh.scale.setScalar(1 + k * e.size);
        e.mesh.material.opacity = 1 - k;
      } else if (e.kind === 'ring') {
        const r = 1 + k * e.size;
        e.mesh.scale.set(r, r, 1);
        e.mesh.material.opacity = 0.85 * (1 - k);
      } else if (e.kind === 'plume') {
        // fast overshoot expansion, slow rise, fade in the last 40%
        const ext = 1 - Math.pow(1 - k, 3);
        for (const b of e.blobs) {
          b.m.position.set(
            b.tx * (0.15 + 0.85 * ext),
            b.ty * (0.25 + 0.75 * ext),
            b.tz * (0.15 + 0.85 * ext)
          );
        }
        e.mesh.position.y += dt * 0.6 * e.size;
        e.mesh.rotation.y += dt * 0.15;
        if (k > 0.6) {
          const op = 1 - (k - 0.6) / 0.4;
          for (const m of e.mats) m.opacity = op;
        }
      } else if (e.kind === 'debris') {
        e.vy -= CFG.gravity * 2.2 * dt;       // slightly heavy debris reads better
        e.mesh.position.x += e.vx * dt;
        e.mesh.position.y += e.vy * dt;
        e.mesh.position.z += e.vz * dt;
        e.mesh.rotation.x += e.rx * dt;
        e.mesh.rotation.z += e.rz * dt;
        const gy = G.terrainHeight(e.mesh.position.x, e.mesh.position.z);
        if (e.mesh.position.y < gy) e.t = e.life;   // kill on ground
      }
    }
  }

  G.spawnDust = spawnDust;
  G.updateDust = updateDust;
  G.emitWheelDustFor = emitWheelDustFor;
  G.dustBurst = dustBurst;
  G.explosion = explosion;
  G.updateFx = updateFx;
  G.dustMat = dustMat;
})();
