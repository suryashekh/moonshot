/* ================================================================
   MAIN — lobby UI wiring, the chase camera (ported, with an
   additive shake budget that explosions/quakes can feed) and the
   game loop that drives every system.
   ================================================================ */
(function () {
  const S = SHARED, clamp = G.clamp, lerp = G.lerp;
  const $ = (id) => document.getElementById(id);

  /* ---------------- lobby UI ---------------- */
  const elLobby = $('lobby'), elMenu = $('menuPane'), elRoom = $('roomInfo');
  const elName = $('nameIn'), elCode = $('codeIn'), elErr = $('lobbyErr');
  const elRoomCode = $('roomCode'), elShare = $('shareUrl'), elPlist = $('plist');
  const elStart = $('startBtn'), elSolo = $('soloBtn'), elAgain = $('againBtn');

  elName.value = localStorage.getItem('lr_name') || '';

  function pilotName() {
    const n = (elName.value || '').trim() || 'PILOT-' + ((Math.random() * 900 + 100) | 0);
    localStorage.setItem('lr_name', n);
    G.state.myName = n;
    return n;
  }

  $('hostBtn').addEventListener('click', () => { elErr.textContent = ''; G.net.host(pilotName()); });
  $('joinBtn').addEventListener('click', () => {
    const code = (elCode.value || '').trim().toUpperCase();
    if (code.length !== 4) { elErr.textContent = 'Room code is 4 characters.'; return; }
    elErr.textContent = '';
    G.net.join(code, pilotName());
  });
  elStart.addEventListener('click', () => G.net.start(false));
  elSolo.addEventListener('click', () => G.net.start(true));
  elAgain.addEventListener('click', () => G.net.toLobby());

  G.onLobbyError = (msg) => { elErr.textContent = msg || 'Connection error.'; };

  G.onJoined = function (m) {
    G.state.phase = m.state === 'race' ? 'race' : 'lobby';
    elMenu.style.display = 'none';
    elRoom.style.display = 'block';
    elRoomCode.textContent = m.code;
    elShare.textContent = (m.urls && m.urls[0]) ? m.urls.join('  ·  ') : location.origin;
    G.refreshLobby();
  };

  G.lobbyPlayers = [];
  G.refreshLobby = function () {
    elPlist.innerHTML = '';
    for (const p of G.lobbyPlayers) {
      const li = document.createElement('li');
      const hex = '#' + p.color.toString(16).padStart(6, '0');
      li.innerHTML =
        `<span style="color:${hex}">■&nbsp;</span>${p.name}` +
        `<span class="tag">${p.id === G.state.hostId ? 'HOST' : ''}` +
        `${p.id === G.state.myId ? ' YOU' : ''}${p.connected ? '' : ' · LINK LOST'}</span>`;
      elPlist.appendChild(li);
    }
    const amHost = G.state.hostId === G.state.myId;
    elStart.style.display = amHost ? 'block' : 'none';
    elSolo.style.display = amHost ? 'block' : 'none';
    elStart.disabled = G.lobbyPlayers.length < 2;
    elStart.textContent = G.lobbyPlayers.length < 2
      ? 'Start Race (need 2+ pilots)' : 'Start Race';
    $('endWait').style.display = amHost ? 'none' : 'block';
    elAgain.style.display = amHost ? 'inline-block' : 'none';
  };

  G.enterGameView = function () {
    elLobby.classList.add('hidden');
    document.getElementById('vitals').classList.add('show');
    document.getElementById('race').classList.add('show');
    document.getElementById('minimapPanel').classList.add('show');
  };
  G.enterLobbyView = function () {
    elLobby.classList.remove('hidden');
    G.refreshLobby();
  };

  /* ---------------- camera ---------------- */
  let cameraSnap = true;
  Object.defineProperty(G, 'cameraSnap', {
    get: () => cameraSnap, set: (v) => { cameraSnap = v; },
  });
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const _camDP = new THREE.Vector3(), _camDL = new THREE.Vector3();
  let shakeBudget = 0;
  G.addCamShake = (s) => { shakeBudget = Math.min(shakeBudget + s, 0.6); };

  function updateCamera(dt, now) {
    const rover = G.rover, camera = G.camera;

    if (G.state.phase === 'menu' || G.state.phase === 'lobby') {
      // slow orbit over the start straight
      const t = now * 0.00006;
      const g0 = G.GATES[0];
      const cx = g0.x + Math.cos(t) * 60, cz = g0.z + Math.sin(t) * 60;
      camera.position.set(cx, G.terrainHeight(cx, cz) + 24, cz);
      camera.lookAt(g0.x, G.terrainHeight(g0.x, g0.z) + 4, g0.z);
      cameraSnap = true;
      return;
    }

    const sinH = Math.sin(rover.heading), cosH = Math.cos(rover.heading);
    _camDP.set(rover.pos.x - sinH * 8.2, rover.pos.y + 3.4, rover.pos.z - cosH * 8.2);
    const minY = G.terrainHeight(_camDP.x, _camDP.z) + 1.3;
    if (_camDP.y < minY) _camDP.y = minY;
    _camDL.set(rover.pos.x + sinH * 2.2, rover.pos.y + 1.2, rover.pos.z + cosH * 2.2);

    if (cameraSnap) {
      camPos.copy(_camDP); camLook.copy(_camDL); cameraSnap = false;
    } else {
      camPos.lerp(_camDP, 1 - Math.exp(-4.2 * dt));
      camLook.lerp(_camDL, 1 - Math.exp(-7 * dt));
    }

    const hSpeed = Math.hypot(rover.vel.x, rover.vel.z);
    let shake = rover.grounded ? clamp((hSpeed - 8.5) / 8, 0, 1) * 0.05 : 0;
    const zone = S.zoneAt(rover.pos.x, rover.pos.z);
    if (zone === 'rough' && rover.grounded && hSpeed > 2) shake += 0.06;
    shake += shakeBudget;
    shakeBudget *= Math.exp(-3.5 * dt);

    camera.position.set(
      camPos.x + (Math.random() - 0.5) * shake,
      camPos.y + (Math.random() - 0.5) * shake,
      camPos.z + (Math.random() - 0.5) * shake
    );
    camera.lookAt(camLook);

    const boost = G.state.boostUntil > G.serverNow() ? 8 : 0;
    const fovT = 62 + clamp((hSpeed - 5 + boost) / 9, 0, 1) * 11;
    if (Math.abs(camera.fov - fovT) > 0.05) {
      camera.fov = lerp(camera.fov, fovT, 1 - Math.exp(-3 * dt));
      camera.updateProjectionMatrix();
    }

    G.dustMat.uniforms.uScale.value =
      G.renderer.domElement.height / (2 * Math.tan(camera.fov * 0.5 * Math.PI / 180));
  }

  /* ---------------- main loop ---------------- */
  let lastTime = performance.now();
  let booted = false;

  function tick(now) {
    requestAnimationFrame(tick);
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt <= 0) return;
    dt = Math.min(dt, 1 / 30);

    const inGame = G.state.phase === 'countdown' || G.state.phase === 'race' || G.state.phase === 'end';

    if (inGame) {
      G.physicsStep(dt);
      G.syncBuggy(dt);
      G.emitMyWheelDust(dt);
      G.updateTracks();
      G.updateRemotes(dt);
      G.updateRace(dt, now);
      G.updateAsteroids(dt);
      G.updateCrates(dt);
      G.updateCombat(dt);
      G.updateHazards(dt);
      G.netTick(now);
      G.hud.update(now);
      G.sun.position.copy(G.rover.pos).addScaledVector(G.SUN_DIR, 260);
      G.sun.target.position.copy(G.rover.pos);
    } else {
      // menu/lobby: world idles, crates twinkle
      G.updateCrates(dt);
      G.updateRace(dt, now);
      const c = G.camera.position;
      G.sun.position.set(c.x, 0, c.z).addScaledVector(G.SUN_DIR, 260);
      G.sun.target.position.set(c.x, 0, c.z);
    }

    G.updateDust(dt);
    G.updateFx(dt);
    G.flushTrackTexture(now);
    updateCamera(dt, now);

    const ec = G.getEarthClouds();
    if (ec) ec.rotation.y += 0.004 * dt;

    G.renderer.render(G.scene, G.camera);

    if (!booted) {
      booted = true;
      document.getElementById('boot').classList.add('done');
      elLobby.classList.remove('hidden');
    }
  }

  // park the local rover at the start straight so the menu orbit has a subject
  G.placeRoverAt(G.GATES[0].x, G.GATES[0].z - 16, G.GATES[0].heading);
  requestAnimationFrame(tick);
})();
