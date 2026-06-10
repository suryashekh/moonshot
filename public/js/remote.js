/* ================================================================
   REMOTE — other players' rovers. Snapshot ring buffer rendered
   at serverTime − interpMs, terrain-normal chassis orientation,
   spinning wheels driven by the synced forward speed, name tag
   sprite, shield / EMP / dead / invuln visuals and light dust.
   ================================================================ */
(function () {
  const S = SHARED, lerp = G.lerp, clamp = G.clamp;
  const UP = new THREE.Vector3(0, 1, 0);
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _n = new THREE.Vector3();
  const _basis = new THREE.Matrix4(), _q = new THREE.Quaternion();

  function makeNameSprite(name, colorHex) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = '700 30px "Segoe UI", system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const hex = '#' + colorHex.toString(16).padStart(6, '0');
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 8;
    g.fillStyle = hex;
    g.fillText(name.toUpperCase().slice(0, 12), 128, 32);
    const tex = new THREE.CanvasTexture(c);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false,
    }));
    sp.scale.set(5.4, 1.35, 1);
    sp.position.y = 3.0;
    return sp;
  }

  class RemotePlayer {
    constructor(id, name, color) {
      this.id = id; this.name = name; this.color = color;
      this.rig = G.buildBuggy(color);
      this.rig.group.add(makeNameSprite(name, color));
      G.scene.add(this.rig.group);

      this.buf = [];               // [{ts,x,y,z,yaw,vf,flags}]
      this.x = 0; this.y = 0; this.z = 0; this.yaw = 0; this.vf = 0;
      this.flags = 0; this.hp = 100; this.lap = 1; this.rank = 1; this.nextGate = 0;
      this.normal = new THREE.Vector3(0, 1, 0);
      this.emitter = { vx: 0, vz: 0, vL: 0, grounded: true, braking: false, dustAccum: 0 };
      this.prevX = 0; this.prevZ = 0;
      this.velX = 0; this.velZ = 0;
      this.trackPrev = null;
      this.lightsWere = false;
    }

    push(ts, x, y, z, yaw, vf, flags) {
      this.buf.push({ ts, x, y, z, yaw, vf, flags });
      if (this.buf.length > 30) this.buf.shift();
      this.flags = flags;
    }

    update(dt) {
      const rt = G.serverNow() - S.NET.interpMs;
      const b = this.buf;
      let p0 = null, p1 = null;
      for (let i = b.length - 1; i >= 0; i--) {
        if (b[i].ts <= rt) { p0 = b[i]; p1 = b[i + 1] || null; break; }
      }
      if (!p0 && b.length) p0 = b[0];
      if (!p0) return;

      let x, y, z, yaw, vf;
      if (p1 && p1.ts > p0.ts) {
        const t = clamp((rt - p0.ts) / (p1.ts - p0.ts), 0, 1);
        x = lerp(p0.x, p1.x, t); y = lerp(p0.y, p1.y, t); z = lerp(p0.z, p1.z, t);
        let dy = p1.yaw - p0.yaw;
        if (dy > Math.PI) dy -= Math.PI * 2; if (dy < -Math.PI) dy += Math.PI * 2;
        yaw = p0.yaw + dy * t;
        vf = lerp(p0.vf, p1.vf, t);
      } else {
        // brief extrapolation from the last sample's heading + speed
        const ageS = clamp((rt - p0.ts) / 1000, 0, 0.25);
        x = p0.x + Math.sin(p0.yaw) * p0.vf * ageS;
        z = p0.z + Math.cos(p0.yaw) * p0.vf * ageS;
        y = p0.y; yaw = p0.yaw; vf = p0.vf;
      }

      const vx = (x - this.prevX) / Math.max(dt, 1e-3);
      const vz = (z - this.prevZ) / Math.max(dt, 1e-3);
      this.prevX = x; this.prevZ = z;
      this.x = x; this.y = y; this.z = z; this.yaw = yaw; this.vf = vf;
      this.velX = vx; this.velZ = vz;   // for local car-vs-car collision response

      const gy = G.terrainHeight(x, z);
      const grounded = (this.flags & S.F.AIR) === 0;
      const renderY = grounded ? gy : Math.max(y, gy);

      const grp = this.rig.group;
      grp.position.set(x, renderY, z);

      // chassis orientation
      if (grounded) {
        G.terrainNormal(x, z, _n);
        this.normal.lerp(_n, 1 - Math.exp(-8 * dt)).normalize();
      } else {
        this.normal.lerp(UP, 1 - Math.exp(-1.2 * dt)).normalize();
      }
      _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
      _fwd.addScaledVector(this.normal, -_fwd.dot(this.normal)).normalize();
      _right.crossVectors(this.normal, _fwd).normalize();
      _basis.makeBasis(_right, this.normal, _fwd);
      _q.setFromRotationMatrix(_basis);
      grp.quaternion.slerp(_q, 1 - Math.exp(-8 * dt));

      // wheels (split GLB wheels: roll about the axle)
      if (this.rig.modelWheels) {
        const roll = (vf / G.CFG.wheelRadius) * dt * (G.WHEEL_ROLL_SIGN || 1);
        for (const w of this.rig.modelWheels) w.spin.rotation.z += roll;
      }

      // status visuals
      const sNow = G.serverNow();
      this.rig.shieldMesh.visible = (this.flags & S.F.SHIELD) !== 0;
      const dead = (this.flags & S.F.DEAD) !== 0;
      const flick = (this.flags & S.F.INVULN) !== 0 && (performance.now() % 200 < 100);
      grp.visible = !dead && !flick;
      const lights = (this.flags & S.F.LIGHTS) !== 0;
      if (lights !== this.lightsWere) { this.rig.setLights(lights); this.lightsWere = lights; }

      // modest dust + faint track for remotes
      if (!dead && grounded) {
        this.emitter.vx = vx; this.emitter.vz = vz;
        this.emitter.vL = (this.flags & S.F.DRIFT) ? 2.5 : 0;
        this.emitter.grounded = true;
        G.emitWheelDustFor(this.emitter, [{ x, y: gy, z }], dt, 0.45);

        const hs = Math.hypot(vx, vz);
        if (hs > 0.6) {
          if (this.trackPrev) {
            const dx = x - this.trackPrev.x, dz = z - this.trackPrev.z;
            const d2 = dx * dx + dz * dz;
            if (d2 > 0.04 && d2 < 200) {
              G.trackStamp(this.trackPrev.x, this.trackPrev.z, x, z, 0.13, 1.8);
              this.trackPrev.x = x; this.trackPrev.z = z;
            } else if (d2 >= 200) { this.trackPrev.x = x; this.trackPrev.z = z; }
          } else this.trackPrev = { x, z };
        }
      } else this.trackPrev = null;

      // smoke trail when badly damaged
      if (!dead && this.hp < 35 && Math.random() < dt * 14) {
        G.spawnDust(x, renderY + 1.2, z,
          (Math.random() - 0.5) * 0.5, 1.3 + Math.random(), (Math.random() - 0.5) * 0.5,
          0.2 + Math.random() * 0.2, 1.6, 0.4, renderY - 1);
      }
    }

    dispose() {
      G.scene.remove(this.rig.group);
    }
  }

  G.remotes = new Map();   // id -> RemotePlayer

  G.ensureRemote = function (id, name, color) {
    if (id === G.state.myId) return null;
    let r = G.remotes.get(id);
    if (!r) { r = new RemotePlayer(id, name || 'PILOT', color || 0xffffff); G.remotes.set(id, r); }
    return r;
  };
  G.removeRemote = function (id) {
    const r = G.remotes.get(id);
    if (r) { r.dispose(); G.remotes.delete(id); }
  };
  G.clearRemotes = function () {
    for (const r of G.remotes.values()) r.dispose();
    G.remotes.clear();
  };
  G.updateRemotes = function (dt) {
    for (const r of G.remotes.values()) r.update(dt);
  };
})();
