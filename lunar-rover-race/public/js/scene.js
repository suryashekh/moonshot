/* ================================================================
   SCENE — renderer, camera, lunar lighting, space backdrop.
   Ported from the base simulator unchanged (stars / sun / Earth).
   ================================================================ */
(function () {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x0c0b0a, 0.00095);

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 9000);

  const SUN_DIR = new THREE.Vector3(-0.45, 0.38, 0.55).normalize();
  const EARTH_DIR = new THREE.Vector3(0.35, 0.42, 0.84).normalize();

  const sun = new THREE.DirectionalLight(0xfff2dc, 2.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 600;
  sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
  sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.4;
  scene.add(sun);
  scene.add(sun.target);

  const earthshine = new THREE.DirectionalLight(0x7fa8e0, 0.18);
  earthshine.position.copy(EARTH_DIR).multiplyScalar(100);
  scene.add(earthshine);

  scene.add(new THREE.HemisphereLight(0x0d1320, 0x2a2722, 0.32));
  scene.add(new THREE.AmbientLight(0x33384a, 0.10));

  const glowTex = G.makeGlowTexture();

  /* ---- starfield ---- */
  (function buildStars() {
    const rng = G.mulberry32(1234);
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rng() * 2 - 1, th = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const r = 4200 + rng() * 700;
      pos[i * 3] = s * Math.cos(th) * r; pos[i * 3 + 1] = u * r; pos[i * 3 + 2] = s * Math.sin(th) * r;
      const b = 0.25 + Math.pow(rng(), 2.2) * 0.75;
      const t = rng();
      col[i * 3] = b * (0.85 + t * 0.15);
      col[i * 3 + 1] = b * (0.88 + t * 0.10);
      col[i * 3 + 2] = b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 2.1, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0.95, fog: false, depthWrite: false,
    });
    scene.add(new THREE.Points(g, m));
  })();

  /* ---- sun glare ---- */
  (function buildSun() {
    const sunPos = SUN_DIR.clone().multiplyScalar(5200);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xfff4da, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, fog: false, depthWrite: false,
    }));
    halo.position.copy(sunPos); halo.scale.setScalar(2600); scene.add(halo);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, fog: false, depthWrite: false,
    }));
    core.position.copy(sunPos); core.scale.setScalar(820); scene.add(core);
  })();

  /* ---- Earth (procedural textures, ported) ---- */
  let earthClouds = null;
  function buildEarthTextures() {
    const W = 512, H = 256;
    const cEarth = document.createElement('canvas'); cEarth.width = W; cEarth.height = H;
    const cCloud = document.createElement('canvas'); cCloud.width = W; cCloud.height = H;
    const gE = cEarth.getContext('2d'), gC = cCloud.getContext('2d');
    const dE = gE.createImageData(W, H), dC = gC.createImageData(W, H);
    const clamp = G.clamp, fbm3 = G.fbm3;
    for (let iy = 0; iy < H; iy++) {
      const v = iy / H;
      const lat = (0.5 - v) * Math.PI;
      const cosLat = Math.cos(lat), sinLat = Math.sin(lat);
      for (let ix = 0; ix < W; ix++) {
        const u = ix / W;
        const th = u * Math.PI * 2;
        const sx = Math.cos(th) * cosLat, sy = sinLat, sz = Math.sin(th) * cosLat;
        const cont = fbm3(sx * 2.3 + 5.0, sy * 2.3 + 5.0, sz * 2.3 + 5.0, 4);
        const det = fbm3(sx * 6.5 + 40., sy * 6.5 + 40., sz * 6.5 + 40., 3);
        let r, g2, b;
        if (cont > 0.545) {
          const veg = clamp((det - 0.3) * 1.6, 0, 1);
          const shade = 0.78 + 0.22 * cosLat;
          r = (98 + veg * -28 + det * 70) * shade;
          g2 = (84 + veg * 34 + det * 48) * shade;
          b = (52 + veg * -10 + det * 38) * shade;
        } else {
          const dep = clamp((0.545 - cont) * 3.2, 0, 1) * (0.8 + det * 0.3);
          r = 14 + (1 - dep) * 36; g2 = 48 + (1 - dep) * 60; b = 96 + (1 - dep) * 70;
        }
        const ice = clamp((Math.abs(sinLat) - 0.78) * 7.0, 0, 1) * (0.6 + det * 0.5);
        r = r + (235 - r) * ice; g2 = g2 + (240 - g2) * ice; b = b + (245 - b) * ice;
        const k = (iy * W + ix) * 4;
        dE.data[k] = r; dE.data[k + 1] = g2; dE.data[k + 2] = b; dE.data[k + 3] = 255;
        const cl = fbm3(sx * 3.4 + 91., sy * 4.4 + 91., sz * 3.4 + 91., 4)
          * (0.75 + 0.25 * fbm3(sx * 9 + 7, sy * 9 + 7, sz * 9 + 7, 2));
        const a = clamp((cl - 0.50) * 4.2, 0, 1) * 235;
        dC.data[k] = 255; dC.data[k + 1] = 255; dC.data[k + 2] = 255; dC.data[k + 3] = a;
      }
    }
    gE.putImageData(dE, 0, 0); gC.putImageData(dC, 0, 0);
    const tE = new THREE.CanvasTexture(cEarth); tE.encoding = THREE.sRGBEncoding;
    const tC = new THREE.CanvasTexture(cCloud); tC.encoding = THREE.sRGBEncoding;
    return { earth: tE, clouds: tC };
  }
  (function buildEarth() {
    const tex = buildEarthTextures();
    const R = 300;
    const pos = EARTH_DIR.clone().multiplyScalar(4600);
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 32),
      new THREE.MeshLambertMaterial({ map: tex.earth, fog: false })
    );
    earth.position.copy(pos);
    scene.add(earth);
    earthClouds = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.012, 48, 32),
      new THREE.MeshLambertMaterial({ map: tex.clouds, transparent: true, depthWrite: false, fog: false })
    );
    earthClouds.position.copy(pos);
    scene.add(earthClouds);
    const atmo = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.045, 48, 32),
      new THREE.MeshBasicMaterial({
        color: 0x3f7fd1, transparent: true, opacity: 0.16,
        side: THREE.BackSide, blending: THREE.AdditiveBlending,
        fog: false, depthWrite: false,
      })
    );
    atmo.position.copy(pos);
    scene.add(atmo);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0x6f9fd8, transparent: true, opacity: 0.38,
      blending: THREE.AdditiveBlending, fog: false, depthWrite: false,
    }));
    halo.position.copy(pos).addScaledVector(EARTH_DIR, 220);
    halo.scale.setScalar(R * 4.6);
    scene.add(halo);
  })();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  G.renderer = renderer;
  G.scene = scene;
  G.camera = camera;
  G.sun = sun;
  G.SUN_DIR = SUN_DIR;
  G.glowTex = glowTex;
  G.getEarthClouds = () => earthClouds;
  G.baseFog = 0.00095;
})();
