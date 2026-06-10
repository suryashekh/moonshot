/* ================================================================
   ROVER — LRV model factory (color-accented per player) + the
   LOCAL player's physics. The heightfield vehicle dynamics are
   the base sim's, extended with race-state modifiers:
     boost / EMP impair / gravity stabilizer / trap slip /
     slip & rough zones / jump pads / damage-limited top speed.
   ================================================================ */
(function () {
  const CFG = G.CFG, clamp = G.clamp, lerp = G.lerp, HALF = G.HALF;
  const S = SHARED;

  /* ---------------- rover model (GLB) ----------------
     The blocky procedural buggy was replaced with the lunar-rover GLB
     (public/models/rover.glb). The model is loaded once, normalized to
     the sim's footprint, then cloned per rig. Tunables below let you
     re-fit the asset without touching the rest of the file. */
  const MODEL_URL      = '/models/rover.glb';
  const MODEL_TARGET_LEN = 3.4;        // world units along the model's longest horizontal axis
  const MODEL_YAW        = Math.PI / 2; // model length runs along X; rotate 90° to face +Z (forward).
                                        // If it drives backward, flip to -Math.PI / 2.
  const MODEL_Y_OFFSET   = 0;          // nudge up/down if wheels float / sink after auto-fit

  let _modelProto = null;         // normalized THREE.Group, cloned per rig
  let _modelFailed = false;
  const _pendingRigs = [];        // rigs built before the model finished loading

  // Center horizontally, rest the base on y=0, scale to MODEL_TARGET_LEN, face +Z.
  function normalizeModel(root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const longest = Math.max(size.x, size.z) || 1;
    const s = MODEL_TARGET_LEN / longest;

    root.position.set(-center.x, -box.min.y + MODEL_Y_OFFSET, -center.z);
    root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    const wrap = new THREE.Group();
    wrap.add(root);
    wrap.scale.setScalar(s);
    wrap.rotation.y = MODEL_YAW;
    return wrap;
  }

  function attachModelTo(rig) {
    if (_modelFailed) return;
    if (!_modelProto) { _pendingRigs.push(rig); return; }
    const m = _modelProto.clone(true);   // shares geometry/material refs across players
    if (rig.placeholder) { rig.group.remove(rig.placeholder); rig.placeholder = null; }
    rig.group.add(m);
    rig.model = m;
  }

  (function loadModel() {
    if (!THREE.GLTFLoader) {
      console.warn('[rover] THREE.GLTFLoader unavailable — keeping placeholder body');
      _modelFailed = true;
      return;
    }
    new THREE.GLTFLoader().load(
      MODEL_URL,
      (gltf) => {
        _modelProto = normalizeModel(gltf.scene);
        for (const rig of _pendingRigs) attachModelTo(rig);
        _pendingRigs.length = 0;
      },
      undefined,
      (err) => {
        console.error('[rover] failed to load', MODEL_URL, err);
        _modelFailed = true;
      }
    );
  })();

  /* ---------------- buggy factory ----------------
     Returns a rig usable by both the local player and remotes. The visible
     body is the loaded GLB; the wheel pivots/spins and other fields below are
     kept (as lightweight, mostly invisible rigging) so the physics step,
     syncBuggy(), and remote interpolation keep their existing contract. */
  function buildBuggy(accentHex) {
    const buggy = new THREE.Group();

    // fender = the per-player accent color (set at build time, re-tinted via setMyColor).
    const MAT = {
      fender: new THREE.MeshStandardMaterial({ color: accentHex, metalness: 0.3, roughness: 0.6 }),
      lens:   new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xfff3cf, emissiveIntensity: 0.25 }),
    };

    // Placeholder shown during the (large) GLB download and if loading fails,
    // so the rover is always visible and driveable. Removed once the model attaches.
    const placeholder = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.6, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x6b6f76, metalness: 0.5, roughness: 0.6 })
    );
    placeholder.position.y = 0.7;
    placeholder.castShadow = true; placeholder.receiveShadow = true;
    buggy.add(placeholder);

    // Accent beacon so each player's color reads from far away / above —
    // the GLB has its own baked materials, so this is what setMyColor tints.
    const beacon = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 8), MAT.fender);
    beacon.position.set(0, 2.25, 0);
    beacon.castShadow = true;
    buggy.add(beacon);

    // Headlight lenses (visible emissive source) + spotlight, at the model's nose (+Z).
    for (const lx of [-0.45, 0.45]) {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 12), MAT.lens);
      lens.position.set(lx, 0.7, MODEL_TARGET_LEN / 2 - 0.05);
      lens.rotation.x = Math.PI / 2;
      buggy.add(lens);
    }
    const headlamp = new THREE.SpotLight(0xfff2cf, 0, 70, 0.55, 0.5, 1.2);
    headlamp.position.set(0, 0.85, 1.4);
    buggy.add(headlamp);
    headlamp.target.position.set(0, 0.1, 15);
    buggy.add(headlamp.target);

    // --- Wheel footprint (drives physics + suspension/steer/spin animation).
    // Kept identical to the original sim; the pivots/spins are invisible rigging
    // nodes the GLB rides on, so syncBuggy()/remote.js animate them harmlessly.
    const WHEELS_LOCAL = [
      { lx: -CFG.trackWidth / 2, lz:  CFG.wheelBase / 2, front: true  },
      { lx:  CFG.trackWidth / 2, lz:  CFG.wheelBase / 2, front: true  },
      { lx: -CFG.trackWidth / 2, lz: -CFG.wheelBase / 2, front: false },
      { lx:  CFG.trackWidth / 2, lz: -CFG.wheelBase / 2, front: false },
    ];
    const wheelPivots = [], wheelSpins = [];
    const WHEEL_REST_Y = CFG.wheelRadius;
    for (const w of WHEELS_LOCAL) {
      const pivot = new THREE.Group();
      pivot.position.set(w.lx, WHEEL_REST_Y, w.lz);
      const spin = new THREE.Group();
      pivot.add(spin);
      wheelPivots.push(pivot);
      wheelSpins.push(spin);
    }

    // --- shield bubble (hidden unless active) ---
    const shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(2.6, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0x69e8ff, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })
    );
    shieldMesh.position.y = 1.0;
    shieldMesh.visible = false;
    buggy.add(shieldMesh);

    let lightsOn = false;
    function setLights(on) {
      lightsOn = on;
      headlamp.intensity = on ? 2.4 : 0;
      MAT.lens.emissiveIntensity = on ? 3.0 : 0.25;
    }

    const rig = {
      group: buggy, MAT, WHEELS_LOCAL, wheelPivots, wheelSpins,
      WHEEL_REST_Y, headlamp, shieldMesh, placeholder, model: null,
      setLights, get lightsOn() { return lightsOn; },
    };
    attachModelTo(rig);   // swaps in the GLB now if loaded, else when it arrives
    return rig;
  }
  G.buildBuggy = buildBuggy;

  /* ---------------- local player ---------------- */
  const rig = buildBuggy(0x4fd2ff);   // re-tinted on join with the assigned color
  G.scene.add(rig.group);
  G.myRig = rig;

  G.setMyColor = function (hex) {
    rig.MAT.fender.color.setHex(hex);
  };

  const rover = {
    pos: new THREE.Vector3(0, G.terrainHeight(0, 0), 0),
    vel: new THREE.Vector3(),
    heading: 0,
    vF: 0, vL: 0,
    grounded: true,
    airTime: 0,
    throttle: 0, steer: 0,
    normal: new THREE.Vector3(0, 1, 0),
    centerGy: 0,
    wheelGy: [0, 0, 0, 0],
    bounce: 0, bounceVel: 0,
    odo: 0,
    spinVel: 0,            // imposed spin from hits (rad/s, decays)
    slipUntil: 0,          // mine slip: grip near zero until this ts
  };
  G.rover = rover;

  const wheelWorld = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  G.wheelWorld = wheelWorld;
  const UP = new THREE.Vector3(0, 1, 0);
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _nT = new THREE.Vector3();
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();

  /* ---------------- input ---------------- */
  const keys = { fwd: 0, back: 0, left: 0, right: 0, brake: 0 };
  G.keys = keys;
  const KEYMAP = {
    KeyW: 'fwd',  ArrowUp: 'fwd',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    Space: 'brake',
  };
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const k = KEYMAP[e.code];
    if (k) { keys[k] = 1; e.preventDefault(); return; }
    if (e.code === 'KeyR') { if (G.net) G.net.send({ t: 'reqRespawn' }); }
    if (e.code === 'KeyL') { rig.setLights(!rig.lightsOn); }
    if (e.code === 'KeyQ') { if (G.cycleItem) G.cycleItem(1); }
    if (e.code === 'KeyF') { if (G.fireGun) G.fireGun(); e.preventDefault(); }
    if (/^Digit[1-5]$/.test(e.code)) {
      if (G.selectItem) G.selectItem(+e.code.slice(-1) - 1);
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (G.useItem) G.useItem(); e.preventDefault();
    }
    if (e.code === 'Tab') { if (G.hud) G.hud.showScore(true); e.preventDefault(); }
  });
  window.addEventListener('keyup', (e) => {
    const k = KEYMAP[e.code];
    if (k) { keys[k] = 0; e.preventDefault(); }
    if (e.code === 'Tab') { if (G.hud) G.hud.showScore(false); e.preventDefault(); }
  });
  // mouse wheel flips through the weapon rack
  window.addEventListener('wheel', (e) => {
    if (G.state.phase !== 'race' || !G.cycleItem) return;
    G.cycleItem(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });

  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    document.getElementById('touch').classList.add('on');
    document.querySelectorAll('.tbtn').forEach((btn) => {
      const k = btn.dataset.k;
      if (!k) {   // non-movement buttons: item / cycle / blaster
        const fn = btn.id === 't-cycle' ? () => { if (G.cycleItem) G.cycleItem(1); }
          : btn.id === 't-gun' ? () => { if (G.fireGun) G.fireGun(); }
          : () => { if (G.useItem) G.useItem(); };
        btn.addEventListener('pointerdown', (e) => { fn(); e.preventDefault(); });
        return;
      }
      const on  = (e) => { keys[k] = 1; e.preventDefault(); };
      const off = (e) => { keys[k] = 0; e.preventDefault(); };
      btn.addEventListener('pointerdown', on);
      btn.addEventListener('pointerup', off);
      btn.addEventListener('pointercancel', off);
      btn.addEventListener('pointerleave', off);
    });
  }

  /* ---------------- spawn / respawn ---------------- */
  G.placeRoverAt = function (x, z, heading) {
    rover.pos.set(x, G.terrainHeight(x, z), z);
    rover.vel.set(0, 0, 0);
    rover.heading = heading || 0;
    rover.vF = rover.vL = 0;
    rover.throttle = rover.steer = 0;
    rover.normal.set(0, 1, 0);
    rover.bounce = rover.bounceVel = 0;
    rover.grounded = true;
    rover.airTime = 0;
    rover.spinVel = 0;
    G.cameraSnap = true;
  };

  // knockback applied from server damage fx: {kx,kz,mag,spin?,slip?}
  G.applyKnockback = function (fx) {
    if (!fx) return;
    const d = Math.hypot(fx.kx, fx.kz) || 1;
    rover.vel.x += (fx.kx / d) * fx.mag;
    rover.vel.z += (fx.kz / d) * fx.mag;
    rover.vel.y += fx.mag * 0.35;
    rover.grounded = false;
    if (fx.spin) rover.spinVel += (Math.random() < 0.5 ? -1 : 1) * 3.2;
    if (fx.slip) rover.slipUntil = performance.now() + fx.slip;
  };

  /* ---------------- physics ---------------- */
  let ouchCooldown = 0;   // throttle damage reports
  let ramCooldown = 0;    // throttle car-contact ram reports

  function physicsStep(dt) {
    const st = G.state;
    const now = performance.now();
    const sNow = G.serverNow();
    const groundedPrev = rover.grounded;
    const locked = st.controlsLocked || st.deadUntil > sNow;

    const empT = st.empUntil > sNow;
    const boostT = st.boostUntil > sNow;
    const gstabT = st.gstabUntil > sNow;
    const slipT = rover.slipUntil > now;
    const zone = S.zoneAt(rover.pos.x, rover.pos.z);

    // universal GRAV WAVE first, then jump pads on top
    let grav = CFG.gravity * (st.gravUntil > sNow ? st.gravScale : 1);
    for (const j of S.JUMP_PADS) {
      const dx = rover.pos.x - j.x, dz = rover.pos.z - j.z;
      if (dx * dx + dz * dz < j.r * j.r) { grav *= j.gscale; break; }
    }

    // --- Input shaping (EMP slows servo response + caps throttle)
    let thrT = locked ? 0 : (keys.fwd ? 1 : 0) - (keys.back ? 1 : 0);
    let strT = locked ? 0 : (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    if (empT) thrT *= 0.35;
    const servo = empT ? 1.4 : 4.5;
    const servoS = empT ? 1.6 : 5;
    rover.throttle += clamp(thrT - rover.throttle, -dt * servo, dt * servo);
    rover.steer += clamp(strT - rover.steer, -dt * servoS, dt * servoS);

    // --- Sample terrain under each wheel
    const sinH = Math.sin(rover.heading), cosH = Math.cos(rover.heading);
    let cgy = 0;
    for (let i = 0; i < 4; i++) {
      const w = rig.WHEELS_LOCAL[i];
      const wx = rover.pos.x + w.lx * cosH + w.lz * sinH;
      const wz = rover.pos.z - w.lx * sinH + w.lz * cosH;
      const gy = G.terrainHeight(wx, wz);
      wheelWorld[i].set(wx, gy, wz);
      rover.wheelGy[i] = gy;
      cgy += gy;
    }
    rover.centerGy = cgy * 0.25;

    // --- Contact-plane normal
    _v1.set(
      (wheelWorld[0].x + wheelWorld[1].x - wheelWorld[2].x - wheelWorld[3].x) * 0.5,
      (wheelWorld[0].y + wheelWorld[1].y - wheelWorld[2].y - wheelWorld[3].y) * 0.5,
      (wheelWorld[0].z + wheelWorld[1].z - wheelWorld[2].z - wheelWorld[3].z) * 0.5);
    _v2.set(
      (wheelWorld[1].x + wheelWorld[3].x - wheelWorld[0].x - wheelWorld[2].x) * 0.5,
      (wheelWorld[1].y + wheelWorld[3].y - wheelWorld[0].y - wheelWorld[2].y) * 0.5,
      (wheelWorld[1].z + wheelWorld[3].z - wheelWorld[0].z - wheelWorld[2].z) * 0.5);
    _nT.crossVectors(_v1, _v2).normalize();
    if (_nT.y < 0.2) _nT.copy(UP);

    if (groundedPrev) rover.normal.lerp(_nT, 1 - Math.exp(-10 * dt)).normalize();
    else              rover.normal.lerp(UP,  1 - Math.exp(-1.2 * dt)).normalize();
    const n = rover.normal;

    // --- Steering -> heading (+ moonquake noise, + hit spin)
    const hSpeed = Math.hypot(rover.vel.x, rover.vel.z);
    if (groundedPrev) {
      const dir = rover.vF >= -0.2 ? 1 : -1;
      const speedFac = clamp(hSpeed / 3.5, 0, 1) / (1 + hSpeed * 0.035);
      rover.heading += rover.steer * CFG.steerRate * speedFac * dir * dt;
    } else {
      rover.heading += rover.steer * 0.3 * dt;
    }
    if (st.quakeUntil > sNow) {
      rover.heading += (G.vnoise2(now * 0.004, 7.3) - 0.5) * 1.9 * dt;
    }
    if (rover.spinVel !== 0) {
      rover.heading += rover.spinVel * dt;
      rover.spinVel *= Math.exp(-2.4 * dt);
      if (Math.abs(rover.spinVel) < 0.05) rover.spinVel = 0;
    }

    // --- Basis on the contact plane
    _fwd.set(Math.sin(rover.heading), 0, Math.cos(rover.heading));
    _fwd.addScaledVector(n, -_fwd.dot(n)).normalize();
    _right.crossVectors(n, _fwd).normalize();

    // --- Modifier-adjusted performance envelope
    const dmgFac = st.hp < 50 ? (0.55 + 0.45 * st.hp / 50) : 1;   // crippled rover
    let maxSpeed = CFG.maxSpeed * dmgFac + (boostT ? 11 : 0);
    let accel = CFG.engineAccel * (boostT ? 2.2 : 1);
    let rollResist = CFG.rollResist * (zone === 'rough' ? 3.0 : 1);

    if (groundedPrev) {
      let vF = rover.vel.dot(_fwd);
      let vL = rover.vel.dot(_right);

      if (rover.throttle > 0) {
        if (vF < maxSpeed) vF += accel * rover.throttle * dt;
      } else if (rover.throttle < 0) {
        if (vF > 0.4)                    vF += CFG.brakeAccel * rover.throttle * dt;
        else if (vF > -CFG.maxReverse)   vF += accel * 0.7 * rover.throttle * dt;
      }

      // grip stack: handbrake < slip zone < mine slip; gstab pins it high
      let grip = CFG.latGrip;
      if (zone === 'slip') grip *= 0.55;
      if (keys.brake && !locked) { vF *= Math.exp(-2.2 * dt); grip = Math.min(grip, 0.85); }
      if (slipT) grip = 0.25;
      if (G.trapGripAt && G.trapGripAt(rover.pos.x, rover.pos.z)) grip = 0.3;
      if (gstabT) grip = 5.5;

      vL *= Math.exp(-grip * dt);
      vF *= Math.exp(-rollResist * dt);

      rover.vF = vF; rover.vL = vL;
      rover.vel.set(0, 0, 0).addScaledVector(_fwd, vF).addScaledVector(_right, vL);
      rover.vel.x += grav * n.x * dt;
      rover.vel.z += grav * n.z * dt;
    } else {
      rover.vF *= Math.exp(-0.15 * dt);
      rover.vL *= Math.exp(-0.5 * dt);
    }

    // --- Integrate + ground contact
    rover.vel.y -= grav * dt;
    rover.pos.addScaledVector(rover.vel, dt);

    const gNew = G.terrainHeight(rover.pos.x, rover.pos.z);
    if (rover.pos.y <= gNew + 0.001) {
      const impact = rover.vel.y;
      rover.pos.y = gNew;
      if (rover.vel.y < 0) rover.vel.y = 0;
      if (!groundedPrev && impact < -2.0) onLanding(-impact);
      rover.grounded = true;
      rover.airTime = 0;
    } else {
      rover.grounded = (rover.pos.y - gNew) < 0.12;
      if (!rover.grounded) rover.airTime += dt;
    }

    // --- Boulder collisions (+ rock-hit damage report)
    for (let i = 0; i < G.boulderColliders.length; i++) {
      const b = G.boulderColliders[i];
      const dx = rover.pos.x - b.x, dz = rover.pos.z - b.z;
      const rr = b.r + 1.25;
      if (Math.abs(dx) > rr || Math.abs(dz) > rr) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const nx = dx / d, nz = dz / d;
        rover.pos.x = b.x + nx * rr;
        rover.pos.z = b.z + nz * rr;
        const vn = rover.vel.x * nx + rover.vel.z * nz;
        if (vn < 0) {
          rover.vel.x -= nx * vn * 1.35;
          rover.vel.z -= nz * vn * 1.35;
          if (vn < -3) {
            onLanding(-vn * 0.6);
            if (now > ouchCooldown && G.net && st.phase === 'race') {
              ouchCooldown = now + 700;
              G.net.send({ t: 'ouch', kind: 'rock', mag: -vn });
            }
          }
        }
      }
    }

    // --- Soft world boundary
    const B = HALF - 14;
    if (Math.abs(rover.pos.x) > B) { rover.pos.x = clamp(rover.pos.x, -B, B); rover.vel.x *= -0.25; }
    if (Math.abs(rover.pos.z) > B) { rover.pos.z = clamp(rover.pos.z, -B, B); rover.vel.z *= -0.25; }

    rover.odo += hSpeed * dt;

    // --- car-vs-car collision: hard separation + bounce + spin.
    //     A hard hit also reports a ram so the server deals damage
    //     (boost multiplies it server-side).
    if (G.remotes && st.phase === 'race' && !(st.deadUntil > sNow) && st.invulnUntil < sNow) {
      const CAR_R = S.COMBAT.carHitR;
      for (const r of G.remotes.values()) {
        if (r.flags & (S.F.DEAD | S.F.FINISHED)) continue;
        const dx = rover.pos.x - r.x, dz = rover.pos.z - r.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > CAR_R * CAR_R || d2 < 1e-6) continue;
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
        // push out of overlap
        rover.pos.x = r.x + nx * CAR_R;
        rover.pos.z = r.z + nz * CAR_R;
        // bounce off the closing velocity (relative to the remote's motion)
        const rvx = rover.vel.x - (r.velX || 0), rvz = rover.vel.z - (r.velZ || 0);
        const vn = rvx * nx + rvz * nz;
        if (vn < 0) {
          rover.vel.x -= nx * vn * 1.7;
          rover.vel.z -= nz * vn * 1.7;
          const impact = -vn;
          rover.spinVel += (rover.vL >= 0 ? 1 : -1) * Math.min(impact * 0.16, 2.4);
          if (impact > 2.0) {
            G.dustBurst((rover.pos.x + r.x) / 2, rover.pos.y, (rover.pos.z + r.z) / 2, impact * 0.8);
            G.beep(120, 140, 'square', Math.min(0.04 + impact * 0.008, 0.1));
            if (G.addCamShake) G.addCamShake(Math.min(impact * 0.025, 0.25));
          }
          if (impact > 5 && now > ramCooldown && G.net) {
            ramCooldown = now + 900;
            G.net.send({ t: 'ram', target: r.id });
          }
        }
      }
    }
  }

  function onLanding(strength) {
    rover.bounceVel -= Math.min(strength, 10) * 0.045;
    G.dustBurst(rover.pos.x, rover.pos.y, rover.pos.z, strength);
    if (strength > 6 && G.net && G.state.phase === 'race') {
      G.net.send({ t: 'ouch', kind: 'landing', mag: strength });
    }
    if (G.addCamShake) G.addCamShake(Math.min(strength * 0.02, 0.18));
  }

  /* ---------------- visual sync ---------------- */
  const _basis = new THREE.Matrix4();
  const _qTarget = new THREE.Quaternion();

  function syncBuggy(dt) {
    rover.bounceVel += (-rover.bounce * 90 - rover.bounceVel * 9) * dt;
    rover.bounce += rover.bounceVel * dt;

    rig.group.position.set(rover.pos.x, rover.pos.y + rover.bounce, rover.pos.z);

    const n = rover.normal;
    _fwd.set(Math.sin(rover.heading), 0, Math.cos(rover.heading));
    _fwd.addScaledVector(n, -_fwd.dot(n)).normalize();
    _right.crossVectors(n, _fwd).normalize();
    _basis.makeBasis(_right, n, _fwd);
    _qTarget.setFromRotationMatrix(_basis);
    rig.group.quaternion.slerp(_qTarget, 1 - Math.exp(-(rover.grounded ? 9 : 2.5) * dt));

    const k = 1 - Math.exp(-14 * dt);
    for (let i = 0; i < 4; i++) {
      const ww = wheelWorld[i];
      const planeY = rover.centerGy
        - (n.x * (ww.x - rover.pos.x) + n.z * (ww.z - rover.pos.z)) / Math.max(n.y, 0.3);
      const susp = clamp(rover.wheelGy[i] - planeY, -0.26, 0.18);
      const pivot = rig.wheelPivots[i];
      pivot.position.y = lerp(pivot.position.y, rig.WHEEL_REST_Y + susp, k);
      if (rig.WHEELS_LOCAL[i].front) {
        pivot.rotation.y = lerp(pivot.rotation.y, rover.steer * 0.5, 1 - Math.exp(-10 * dt));
      }
      rig.wheelSpins[i].rotation.x += (rover.vF / CFG.wheelRadius) * dt;
    }

    // shield / invuln / dead visuals
    const sNow = G.serverNow();
    rig.shieldMesh.visible = G.state.shieldUntil > sNow;
    if (rig.shieldMesh.visible) {
      rig.shieldMesh.material.opacity = 0.12 + 0.06 * Math.sin(performance.now() * 0.012);
    }
    const flick = G.state.invulnUntil > sNow && (performance.now() % 200 < 100);
    rig.group.visible = !(G.state.deadUntil > sNow) && !flick;
  }

  /* ---------------- tire tracks (local rover) ---------------- */
  const wheelPrevW = [null, null, null, null];
  function updateTracks() {
    if (!rover.grounded) {
      wheelPrevW[0] = wheelPrevW[1] = wheelPrevW[2] = wheelPrevW[3] = null;
      return;
    }
    const hSpeed = Math.hypot(rover.vel.x, rover.vel.z);
    if (hSpeed < 0.25) return;
    const skid = clamp(Math.abs(rover.vL) / 3.5, 0, 1);
    for (let i = 0; i < 4; i++) {
      const ww = wheelWorld[i];
      const prev = wheelPrevW[i];
      if (!prev) { wheelPrevW[i] = { x: ww.x, z: ww.z }; continue; }
      const dx = ww.x - prev.x, dz = ww.z - prev.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= 0.02 && d2 < 200) {
        G.trackStamp(prev.x, prev.z, ww.x, ww.z, 0.16 + skid * 0.34, 1.15 + skid * 0.9);
        prev.x = ww.x; prev.z = ww.z;
      } else if (d2 >= 200) {
        prev.x = ww.x; prev.z = ww.z;
      }
    }
  }

  G.physicsStep = physicsStep;
  G.syncBuggy = syncBuggy;
  G.updateTracks = updateTracks;
  const myEmitter = { vx: 0, vz: 0, vL: 0, grounded: true, braking: false, dustAccum: 0 };
  G.emitMyWheelDust = function (dt) {
    myEmitter.vx = rover.vel.x; myEmitter.vz = rover.vel.z;
    myEmitter.vL = rover.vL; myEmitter.grounded = rover.grounded;
    myEmitter.braking = !!keys.brake;
    G.emitWheelDustFor(myEmitter, wheelWorld, dt, 1);
  };
})();
