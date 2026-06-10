/* ================================================================
   HAZARDS — lap-2+ random events broadcast by the server:
     flare → white wash + HUD glitch + visibility hit
     quake → camera shake + steering noise (handled in rover.js)
     storm → fog density ramp + amber wash
   Lap 3 also gets a permanent ambient visibility reduction.
   ================================================================ */
(function () {
  const elFlare = document.getElementById('flarewash');
  const elStorm = document.getElementById('stormwash');

  G.onHazard = function (m) {
    const until = G.serverNow() + m.ms;
    if (m.kind === 'flare') {
      G.state.flareUntil = until;
      if (G.hud) G.hud.feed('⚠ SOLAR FLARE — telemetry degraded');
      G.beep(1900, 240, 'sine', 0.05);
    } else if (m.kind === 'quake') {
      G.state.quakeUntil = until;
      if (G.hud) G.hud.feed('⚠ MOONQUAKE');
    } else if (m.kind === 'storm') {
      G.state.stormUntil = until;
      if (G.hud) G.hud.feed('⚠ DUST STORM');
    }
  };

  let quakeShakeAcc = 0;

  G.updateHazards = function (dt) {
    const sNow = G.serverNow();
    const st = G.state;

    // flare wash + HUD glitch class
    const flare = st.flareUntil > sNow;
    elFlare.style.opacity = flare ? (0.18 + 0.1 * Math.sin(performance.now() * 0.02)) : 0;
    document.body.classList.toggle('glitch', flare);

    // quake camera shake
    if (st.quakeUntil > sNow) {
      quakeShakeAcc += dt;
      if (quakeShakeAcc > 0.05) {
        quakeShakeAcc = 0;
        if (G.addCamShake) G.addCamShake(0.06);
      }
    }

    // storm + lap-3 ambient fog
    const storm = st.stormUntil > sNow;
    elStorm.style.opacity = storm ? 0.22 : 0;
    let fog = G.baseFog;
    if (storm) fog = 0.0065;
    else if (st.lap >= 3 && st.phase === 'race') fog = 0.0028;
    if (flare) fog = Math.max(fog, 0.004);
    G.scene.fog.density = G.lerp(G.scene.fog.density, fog, 1 - Math.exp(-2 * dt));
  };
})();
