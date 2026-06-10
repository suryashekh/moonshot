/* ================================================================
   TERRAIN — analytic heightfield, regolith texture, tire-track
   canvas, rocks, horizon ring. Ported from the base simulator;
   the only changes are:
     * trackStamp()/paintScorch() so remote rovers and asteroid
       impacts can mark the surface too,
     * boulderColliders exposed on G for physics + combat.
   terrainHeight is deterministic, so every client computes an
   identical Moon — the server never needs the geometry.
   ================================================================ */
(function () {
  const CFG = G.CFG, HALF = G.HALF, clamp = G.clamp;
  const scene = G.scene, renderer = G.renderer;

  /* ---- craters ---- */
  const CRATERS = (function generateCraters() {
    const rng = G.mulberry32(20260610);
    const list = [];
    while (list.length < 26) {
      const x = (rng() * 2 - 1) * (HALF - 50);
      const z = (rng() * 2 - 1) * (HALF - 50);
      if (Math.hypot(x, z) < 55) continue;
      const r = 12 + rng() * rng() * 46;
      const depth = Math.min(r * (0.12 + rng() * 0.08), 7.0);
      list.push({ x, z, r, depth, r2max: (r * 1.45) * (r * 1.45) });
    }
    return list;
  })();

  function craterShape(t, depth) {
    let h = 0;
    if (t < 1) { const q = 1 - t * t; h -= q * q * depth; }
    const g = (t - 1.0) / 0.24;
    h += Math.exp(-g * g) * depth * 0.30;
    return h;
  }

  /* ---- dug racing trench along the track ring ----
     The race path is a sunken, hand-dug-looking trench: wide enough for a
     few rovers side by side (width and depth meander around the lap), with
     smooth banks a rover can always climb to leave for the open map, and
     low spoil berms piled along the edges. Carved straight into the
     heightfield, so physics, rocks, gates and ramps all follow it. */
  const RING_TAU = Math.PI * 2;
  // trackRadius() is not 2π-periodic (3.7x / 6.3x harmonics), so the raw ring
  // has a radial jump at angle 0; cross-fade the last 0.6 rad onto the lap
  // start so the trench centerline closes seamlessly.
  function ringRadiusSmooth(a) {
    const W = 0.6;
    if (a > RING_TAU - W) {
      let t = (a - (RING_TAU - W)) / W;
      t = t * t * (3 - 2 * t);
      return SHARED.trackRadius(a) * (1 - t) + SHARED.trackRadius(a - RING_TAU) * t;
    }
    return SHARED.trackRadius(a);
  }
  function trenchCarve(x, z) {
    const r = Math.hypot(x, z);
    if (r < 150 || r > 345) return 0;                  // ring lives at ~175..315
    const a = (Math.atan2(z, x) + RING_TAU) % RING_TAU;
    const d = Math.abs(r - ringRadiusSmooth(a));
    // integer harmonics of the lap angle → seamless meander of width & depth
    let wHalf = 5.4 + 1.6 * Math.sin(a * 2 + 1.1) + 1.0 * Math.sin(a * 5 + 3.7) + 0.6 * Math.sin(a * 9 + 0.5);
    if (wHalf < 4.4) wHalf = 4.4;                      // never tighter than ~3.4 rovers
    const depth = 1.75 + 0.45 * Math.sin(a * 3 + 2.2) + 0.3 * Math.sin(a * 7 + 0.9);
    // flat floor, then a bank whose run-out grows with depth so its average
    // slope stays ≤ ~0.45 — a rover can always drive out onto the open map
    const flat = wHalf * 0.62;
    const bankLen = Math.max(wHalf * 0.38, depth / 0.45);
    const dB = (d - flat) / bankLen;                   // 0 floor edge → 1 ground level
    if (dB > 1.9) return 0;
    let k = 1;
    if (dB > 0) {
      const s = dB > 1 ? 1 : dB;
      k = 1 - s * s * (3 - 2 * s);
    }
    const b = (dB - 1.25) / 0.3;                       // low spoil berm past the lip
    const berm = depth * 0.18 * Math.exp(-b * b);
    return -depth * k + berm;
  }

  function baseHeight(x, z) {
    let h = (G.fbm2(x * 0.0042, z * 0.0042, 4) - 0.5) * 13.0;
    h += (G.fbm2(x * 0.021 + 7.7, z * 0.021 - 3.3, 3) - 0.5) * 2.4;
    const rr = G.fbm2(x * 0.0085 + 51.2, z * 0.0085 + 27.9, 3);
    h += Math.pow(1.0 - Math.abs(rr * 2 - 1), 3.0) * 2.2 - 0.9;
    h += (G.fbm2(x * 0.13 + 19.1, z * 0.13 + 5.6, 2) - 0.5) * 0.5;
    for (let i = 0; i < CRATERS.length; i++) {
      const c = CRATERS[i];
      const dx = x - c.x, dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > c.r2max) continue;
      h += craterShape(Math.sqrt(d2) / c.r, c.depth);
    }
    h += trenchCarve(x, z);
    return h;
  }

  /* Periodic heightfield for the open (wrap-around) world: coordinates are
     wrapped into the canonical [-wrapHalf, wrapHalf) domain, and a blend band
     inside each wrap edge cross-fades toward the average of the two seam
     sides, so height (and physics) are continuous when you drive across.
     The mesh's 10-unit strip beyond the wrap line then previews the far side
     exactly — the seam is invisible from the ground. */
  const WRAP = SHARED.WORLD.wrapHalf;
  const WRAP_PERIOD = WRAP * 2;
  const SEAM_BAND = 60;
  // ground is drawn this far past each wrap line: because the heightfield is
  // periodic, that strip IS the far side — so the world ahead is already there
  // long before you cross, and the wrap is invisible.
  const PREVIEW = 170;
  const MESH_HALF = WRAP + PREVIEW;
  function seamBlend(av) {            // 0 inside → 0.5 exactly at the wrap line
    if (av < WRAP - SEAM_BAND) return 0;
    let t = (av - (WRAP - SEAM_BAND)) / SEAM_BAND;
    if (t > 1) t = 1;
    return t * t * (3 - 2 * t) * 0.5;
  }
  function heightBlendX(x, z) {
    const u = seamBlend(Math.abs(x));
    if (!u) return baseHeight(x, z);
    const xo = x - Math.sign(x) * WRAP_PERIOD;
    return baseHeight(x, z) * (1 - u) + baseHeight(xo, z) * u;
  }
  function terrainHeight(x, z) {
    x = x - Math.floor((x + WRAP) / WRAP_PERIOD) * WRAP_PERIOD;
    z = z - Math.floor((z + WRAP) / WRAP_PERIOD) * WRAP_PERIOD;
    const u = seamBlend(Math.abs(z));
    if (!u) return heightBlendX(x, z);
    const zo = z - Math.sign(z) * WRAP_PERIOD;
    return heightBlendX(x, z) * (1 - u) + heightBlendX(x, zo) * u;
  }
  function terrainNormal(x, z, out) {
    const e = 0.55;
    const hL = terrainHeight(x - e, z), hR = terrainHeight(x + e, z);
    const hD = terrainHeight(x, z - e), hU = terrainHeight(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  /* ---- regolith albedo texture ---- */
  function buildRegolithTexture() {
    const S = 1024;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const img = g.createImageData(S, S);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let v = 0.56
          + (G.vnoise2(x * 0.045, y * 0.045) - 0.5) * 0.17
          + (G.vnoise2(x * 0.011 + 31, y * 0.011 + 31) - 0.5) * 0.10
          + (G.hash2(x, y) - 0.5) * 0.105;
        v = clamp(v, 0, 1) * 255;
        const k = (y * S + x) * 4;
        img.data[k] = v; img.data[k + 1] = v * 0.985; img.data[k + 2] = v * 0.955;
        img.data[k + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const rng = G.mulberry32(777);
    for (let i = 0; i < 1600; i++) {
      const x = rng() * S, y = rng() * S, r = 1 + rng() * rng() * 7;
      g.fillStyle = 'rgba(0,0,0,' + (0.10 + rng() * 0.18).toFixed(2) + ')';
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,250,240,' + (0.05 + rng() * 0.12).toFixed(2) + ')';
      g.beginPath(); g.arc(x - r * 0.4, y - r * 0.4, r * 0.55, 0, Math.PI * 2); g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(26, 26);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  /* ---- tire tracks / surface scarring canvas ---- */
  const TRACK_RES = 2048;
  const trackCanvas = document.createElement('canvas');
  trackCanvas.width = trackCanvas.height = TRACK_RES;
  const trackCtx = trackCanvas.getContext('2d');
  trackCtx.fillStyle = '#ffffff';
  trackCtx.fillRect(0, 0, TRACK_RES, TRACK_RES);
  trackCtx.lineCap = 'round';

  const trackTexture = new THREE.CanvasTexture(trackCanvas);
  trackTexture.flipY = false;
  trackTexture.generateMipmaps = false;
  trackTexture.minFilter = THREE.LinearFilter;
  trackTexture.magFilter = THREE.LinearFilter;
  // the canvas maps the canonical wrap domain; REPEAT lets the preview strip
  // past the wrap line sample the far side's marks
  trackTexture.wrapS = trackTexture.wrapT = THREE.RepeatWrapping;

  let trackDirty = false;
  let lastTrackUpload = 0;
  const PX_PER_M = TRACK_RES / WRAP_PERIOD;
  const wrapC = SHARED.wrapCoord;
  const toPx = (w) => ((w + WRAP) / WRAP_PERIOD) * TRACK_RES;

  // generic line stamp in world coordinates (used by local + remote wheels)
  function trackStamp(x0, z0, x1, z1, alpha, width) {
    x0 = wrapC(x0); z0 = wrapC(z0); x1 = wrapC(x1); z1 = wrapC(z1);
    // a segment straddling the seam would smear across the whole canvas — skip it
    if (Math.abs(x1 - x0) > WRAP || Math.abs(z1 - z0) > WRAP) return;
    trackCtx.strokeStyle = 'rgba(18,16,14,' + alpha.toFixed(2) + ')';
    trackCtx.lineWidth = width;
    trackCtx.beginPath();
    trackCtx.moveTo(toPx(x0), toPx(z0));
    trackCtx.lineTo(toPx(x1), toPx(z1));
    trackCtx.stroke();
    trackDirty = true;
  }
  // radial scorch decal (asteroid / rocket impacts → "temporary crater" look)
  function paintScorch(x, z, r, strength) {
    const px = toPx(wrapC(x)), py = toPx(wrapC(z)), pr = r * PX_PER_M;
    const grad = trackCtx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, 'rgba(8,7,6,' + (strength || 0.8) + ')');
    grad.addColorStop(0.55, 'rgba(14,12,10,' + ((strength || 0.8) * 0.5).toFixed(2) + ')');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    trackCtx.fillStyle = grad;
    trackCtx.beginPath(); trackCtx.arc(px, py, pr, 0, Math.PI * 2); trackCtx.fill();
    trackDirty = true;
  }
  // soft tint patch (hazard zones get painted once at boot)
  function paintPatch(x, z, r, rgba) {
    const px = toPx(wrapC(x)), py = toPx(wrapC(z)), pr = r * PX_PER_M;
    const grad = trackCtx.createRadialGradient(px, py, 0, px, py, pr);
    grad.addColorStop(0, rgba); grad.addColorStop(1, 'rgba(0,0,0,0)');
    trackCtx.fillStyle = grad;
    trackCtx.beginPath(); trackCtx.arc(px, py, pr, 0, Math.PI * 2); trackCtx.fill();
    trackDirty = true;
  }

  /* ---- terrain mesh (shader patched with the track map) ---- */
  const terrainMaterial = new THREE.MeshStandardMaterial({
    map: buildRegolithTexture(),
    color: 0xd8d2c8, roughness: 1.0, metalness: 0.0,
  });
  terrainMaterial.onBeforeCompile = function (shader) {
    shader.uniforms.uTrack = { value: trackTexture };
    shader.uniforms.uWrapHalf = { value: WRAP };
    shader.uniforms.uWrapPeriod = { value: WRAP_PERIOD };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec2 vTrackUv;\nuniform float uWrapHalf;\nuniform float uWrapPeriod;')
      .replace('#include <begin_vertex>',
        // unwrapped UV over the wrap period; the REPEAT sampler folds the
        // preview strip past the wrap line onto the far side's marks
        '#include <begin_vertex>\nvTrackUv = (position.xz + vec2(uWrapHalf)) / uWrapPeriod;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec2 vTrackUv;\nuniform sampler2D uTrack;')
      .replace('#include <map_fragment>',
        '#include <map_fragment>\n' +
        'float trackK = texture2D( uTrack, vTrackUv ).r;\n' +
        'diffuseColor.rgb *= mix( 0.34, 1.0, trackK );');
  };

  (function buildTerrainMesh() {
    // mesh spans the wrap domain PLUS the preview band on every side; the
    // periodic heightfield makes the strip past each wrap line an exact copy
    // of the far side, so the seam is never a visible edge
    const size = MESH_HALF * 2;
    const seg = Math.round(CFG.terrainSeg * size / CFG.terrainSize);   // keep vertex density
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, terrainMaterial);
    mesh.receiveShadow = true;
    scene.add(mesh);
  })();

  /* ---- horizon ring ---- */
  (function buildHorizonRing() {
    const N = 200;
    const rings = [
      { r: 620, base: -6 },
      { r: 950, base: 0 },
      { r: 1700, base: -40 },
    ];
    const verts = [];
    for (let ri = 0; ri < rings.length; ri++) {
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        let h = rings[ri].base;
        if (ri === 1) {
          const n = G.fbm2(Math.cos(a) * 3.1 + 9, Math.sin(a) * 3.1 + 9, 4);
          h += 14 + Math.pow(n, 1.6) * 130;
        }
        verts.push(Math.cos(a) * rings[ri].r, h, Math.sin(a) * rings[ri].r);
      }
    }
    const idx = [];
    for (let ri = 0; ri < rings.length - 1; ri++) {
      const o0 = ri * (N + 1), o1 = (ri + 1) * (N + 1);
      for (let i = 0; i < N; i++) {
        idx.push(o0 + i, o1 + i, o0 + i + 1, o0 + i + 1, o1 + i, o1 + i + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0x76726b, roughness: 1.0, metalness: 0.0,
    })));
  })();

  /* ---- rocks & boulders ---- */
  const boulderColliders = [];
  function makeRockGeometry(detail, seed) {
    const geo = new THREE.IcosahedronGeometry(1, detail);
    const rng = G.mulberry32(seed);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i,
        p.getX(i) * (0.78 + rng() * 0.5),
        p.getY(i) * (0.62 + rng() * 0.5),
        p.getZ(i) * (0.78 + rng() * 0.5));
    }
    geo.computeVertexNormals();
    return geo;
  }
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.95, metalness: 0.02 });

  // wrap-image offsets for a rock near a wrap edge: its ghost copies appear in
  // the preview strip on the opposite side(s), so scenery — not just ground —
  // is already visible before you cross the seam. Height/normal are periodic,
  // so ghosts sit on identical terrain. Visual only (no ghost colliders).
  function wrapImages(x, z) {
    const xs = [0], zs = [0];
    if (x > WRAP - PREVIEW) xs.push(-WRAP_PERIOD); else if (x < -WRAP + PREVIEW) xs.push(WRAP_PERIOD);
    if (z > WRAP - PREVIEW) zs.push(-WRAP_PERIOD); else if (z < -WRAP + PREVIEW) zs.push(WRAP_PERIOD);
    const out = [];
    for (const dx of xs) for (const dz of zs) out.push([x + dx, z + dz]);
    return out;   // [0] is always the real placement
  }

  (function scatterRocks() {
    const rng = G.mulberry32(4242);
    const up = new THREE.Vector3(0, 1, 0);
    const n = new THREE.Vector3(), q = new THREE.Vector3();
    const quat = new THREE.Quaternion(), spin = new THREE.Quaternion();
    const mtx = new THREE.Matrix4(), sc = new THREE.Vector3();
    const col = new THREE.Color();
    for (let variant = 0; variant < 3; variant++) {
      const COUNT = 230;
      // roll all placements first (stable rng), expand with wrap images, then instance
      const rocks = [];
      for (let i = 0; i < COUNT; i++) {
        let x, z;
        do { x = (rng() * 2 - 1) * (HALF - 18); z = (rng() * 2 - 1) * (HALF - 18); }
        while (Math.hypot(x, z) < 14);
        const s = 0.13 + rng() * rng() * 0.55;
        const yaw = rng() * Math.PI * 2;
        const shade = 0.82 + rng() * 0.3;
        for (const [ix, iz] of wrapImages(x, z)) rocks.push({ x: ix, z: iz, s, yaw, shade });
      }
      const inst = new THREE.InstancedMesh(makeRockGeometry(0, 100 + variant), rockMat, rocks.length);
      inst.castShadow = true; inst.receiveShadow = true;
      rocks.forEach((r, i) => {
        terrainNormal(r.x, r.z, n);
        quat.setFromUnitVectors(up, n);
        spin.setFromAxisAngle(up, r.yaw);
        quat.multiply(spin);
        sc.setScalar(r.s);
        q.set(r.x, terrainHeight(r.x, r.z) - r.s * 0.18, r.z);
        mtx.compose(q, quat, sc);
        inst.setMatrixAt(i, mtx);
        inst.setColorAt(i, col.setScalar(r.shade));
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      scene.add(inst);
    }
    for (let i = 0; i < 42; i++) {
      let x, z;
      do { x = (rng() * 2 - 1) * (HALF - 25); z = (rng() * 2 - 1) * (HALF - 25); }
      while (Math.hypot(x, z) < 32);
      const s = 0.9 + rng() * rng() * 2.6;
      const yaw = rng() * Math.PI * 2;
      const geoB = makeRockGeometry(1, 500 + i);
      for (const [ix, iz] of wrapImages(x, z)) {
        const mesh = new THREE.Mesh(geoB, rockMat);
        mesh.scale.setScalar(s);
        mesh.position.set(ix, terrainHeight(ix, iz) - s * 0.15, iz);
        terrainNormal(ix, iz, n);
        mesh.quaternion.setFromUnitVectors(up, n);
        mesh.rotateY(yaw);
        mesh.castShadow = true; mesh.receiveShadow = true;
        scene.add(mesh);
      }
      boulderColliders.push({ x, z, r: s * 0.88 });   // collider only at the real spot
    }
  })();

  /* ---- paint the dug trench floor once: overlapping soft dark patches along
     the (seam-blended) centerline read as churned, excavated regolith and make
     the sunken path obvious from above and at speed. */
  (function paintTrenchFloor() {
    const rng = G.mulberry32(9090);
    const STEPS = 700;
    for (let i = 0; i < STEPS; i++) {
      const a = (i / STEPS) * RING_TAU;
      const rc = ringRadiusSmooth(a);
      let wHalf = 5.4 + 1.6 * Math.sin(a * 2 + 1.1) + 1.0 * Math.sin(a * 5 + 3.7) + 0.6 * Math.sin(a * 9 + 0.5);
      if (wHalf < 4.4) wHalf = 4.4;
      const jitter = (rng() * 2 - 1) * wHalf * 0.35;
      const x = Math.cos(a) * (rc + jitter), z = Math.sin(a) * (rc + jitter);
      paintPatch(x, z, wHalf * (0.85 + rng() * 0.35), 'rgba(22,19,16,0.07)');
      if (i % 3 === 0) paintPatch(Math.cos(a) * rc, Math.sin(a) * rc, wHalf * 0.55, 'rgba(22,19,16,0.06)');
    }
  })();

  /* ---- paint hazard-zone tints once (visual cue for slip / rough / pads) */
  (function paintZones() {
    const rng = G.mulberry32(5151);
    for (const s of SHARED.ZONES) {
      const steps = 22;
      for (let i = 0; i < steps; i++) {
        const a = s.a0 + (s.a1 - s.a0) * (i / steps);
        const r = SHARED.trackRadius(a) + (rng() * 2 - 1) * 26;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (s.kind === 'slip') paintPatch(x, z, 10 + rng() * 8, 'rgba(210,225,255,0.10)');
        else if (s.kind === 'speed') paintPatch(x, z, 9 + rng() * 6, 'rgba(60,220,255,0.14)');
        else paintPatch(x, z, 7 + rng() * 7, 'rgba(0,0,0,0.16)');
      }
    }
    for (const j of SHARED.JUMP_PADS) {
      paintPatch(j.x, j.z, j.r, 'rgba(255,200,90,0.16)');
    }
    // bright approach marker leading onto each launch ramp
    for (const rp of SHARED.RAMPS) {
      paintPatch(rp.x, rp.z, 11, 'rgba(255,179,71,0.22)');
      const bx = rp.x - Math.sin(rp.heading) * 12, bz = rp.z - Math.cos(rp.heading) * 12;
      paintPatch(bx, bz, 7, 'rgba(255,179,71,0.15)');
    }
  })();

  /* ---- throttled GPU upload, called from main loop ---- */
  function flushTrackTexture(now) {
    if (trackDirty && now - lastTrackUpload > 120) {
      trackTexture.needsUpdate = true;
      trackDirty = false;
      lastTrackUpload = now;
    }
  }

  G.terrainHeight = terrainHeight;
  G.terrainNormal = terrainNormal;
  G.boulderColliders = boulderColliders;
  G.trackStamp = trackStamp;
  G.paintScorch = paintScorch;
  G.flushTrackTexture = flushTrackTexture;
  G.makeRockGeometry = makeRockGeometry;
  G.rockMat = rockMat;
})();
