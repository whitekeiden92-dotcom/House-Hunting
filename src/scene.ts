import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class CabinPreview {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private readonly snow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly snowPositions: Float32Array;
  private readonly snowSpeeds: Float32Array;
  private readonly snowGeometry: THREE.BufferGeometry;
  private readonly clock = new THREE.Clock();
  private readonly initialCameraPosition = new THREE.Vector3(13.5, 8.7, 19.5);
  private readonly initialTarget = new THREE.Vector3(0, 2.5, 0);
  private readonly cameraOrbitStep = THREE.MathUtils.degToRad(18);
  private readonly cameraZoomStep = 3.5;
  private readonly resizeObserver: ResizeObserver;
  private running = true;
  private snowOn = true;
  private frameId = 0;
  private elapsed = 0;

  private readonly onKey = (event: KeyboardEvent): void => {
    const actions: Record<string, () => void> = {
      ArrowLeft: () => this.rotateCamera('left'),
      ArrowRight: () => this.rotateCamera('right'),
      ArrowUp: () => this.zoomCamera('in'),
      ArrowDown: () => this.zoomCamera('out'),
      '+': () => this.zoomCamera('in'),
      '=': () => this.zoomCamera('in'),
      '-': () => this.zoomCamera('out'),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  // A plain wheel over the 3D view should scroll the page, not zoom the cabin.
  private readonly blockWheel = (event: WheelEvent): void => {
    if (event.target === this.canvas && !event.ctrlKey && !event.metaKey) event.stopPropagation();
  };

  constructor(private readonly canvas: HTMLCanvasElement, reducedMotion: boolean) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#252b30');
    this.scene.fog = new THREE.FogExp2('#71635e', 0.009);

    this.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 180);
    this.camera.position.copy(this.initialCameraPosition);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.initialTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 43;
    this.controls.maxPolarAngle = Math.PI * 0.475;
    this.controls.minPolarAngle = Math.PI * 0.19;
    this.controls.enablePan = false;
    this.controls.rotateSpeed = 0.52;
    this.controls.zoomSpeed = 0.72;
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('keydown', this.onKey);
    window.addEventListener('wheel', this.blockWheel, { capture: true, passive: true });

    this.addSky();
    this.addLighting();
    this.addMountains();
    this.addGround();
    this.addForest();
    this.addCabin();
    this.addHotTub();

    const particleCount = window.matchMedia('(max-width: 720px)').matches ? 760 : 1480;
    this.snowPositions = new Float32Array(particleCount * 3);
    this.snowSpeeds = new Float32Array(particleCount);
    for (let i = 0; i < particleCount; i += 1) {
      const offset = i * 3;
      this.snowPositions[offset] = (Math.random() - 0.5) * 50;
      this.snowPositions[offset + 1] = Math.random() * 23 + 1;
      this.snowPositions[offset + 2] = (Math.random() - 0.5) * 38;
      this.snowSpeeds[i] = 0.42 + Math.random() * 0.68;
    }
    this.snowGeometry = new THREE.BufferGeometry();
    this.snowGeometry.setAttribute('position', new THREE.BufferAttribute(this.snowPositions, 3));
    const flakeCanvas = document.createElement('canvas');
    flakeCanvas.width = 32;
    flakeCanvas.height = 32;
    const flakeContext = flakeCanvas.getContext('2d');
    if (flakeContext) {
      const flake = flakeContext.createRadialGradient(16, 16, 1, 16, 16, 16);
      flake.addColorStop(0, 'rgba(255, 255, 255, 1)');
      flake.addColorStop(0.45, 'rgba(255, 255, 255, 0.9)');
      flake.addColorStop(1, 'rgba(255, 255, 255, 0)');
      flakeContext.fillStyle = flake;
      flakeContext.fillRect(0, 0, 32, 32);
    }
    const flakeTexture = new THREE.CanvasTexture(flakeCanvas);
    flakeTexture.colorSpace = THREE.SRGBColorSpace;
    const snowMaterial = new THREE.PointsMaterial({
      color: '#fff9ef',
      size: window.matchMedia('(max-width: 720px)').matches ? 0.085 : 0.105,
      map: flakeTexture,
      alphaTest: 0.08,
      transparent: true,
      opacity: 0.86,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.snow = new THREE.Points(this.snowGeometry, snowMaterial);
    this.snow.frustumCulled = false;
    this.scene.add(this.snow);

    if (reducedMotion) {
      this.running = false;
      this.snowOn = false;
      this.snow.visible = false;
    }

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.animate();
  }

  setMotionEnabled(enabled: boolean): void {
    this.running = enabled;
  }

  get isMotionEnabled(): boolean {
    return this.running;
  }

  setSnowEnabled(enabled: boolean): void {
    this.snowOn = enabled;
    this.snow.visible = enabled;
  }

  get isSnowEnabled(): boolean {
    return this.snowOn;
  }

  resetCamera(): void {
    const mobile = this.canvas.clientWidth < 680;
    this.camera.position.copy(mobile ? new THREE.Vector3(0, 10.5, 29) : this.initialCameraPosition);
    this.controls.target.copy(mobile ? new THREE.Vector3(0, 2.3, 0) : this.initialTarget);
    this.controls.update();
  }

  rotateCamera(direction: 'left' | 'right'): void {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta += direction === 'left' ? -this.cameraOrbitStep : this.cameraOrbitStep;
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi,
      this.controls.minPolarAngle,
      this.controls.maxPolarAngle,
    );
    spherical.makeSafe();

    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  zoomCamera(direction: 'in' | 'out'): void {
    const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const distanceDelta = direction === 'in' ? -this.cameraZoomStep : this.cameraZoomStep;
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius + distanceDelta,
      this.controls.minDistance,
      this.controls.maxDistance,
    );

    offset.setFromSpherical(spherical);
    this.camera.position.copy(this.controls.target).add(offset);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  dispose(): void {
    cancelAnimationFrame(this.frameId);
    window.removeEventListener('wheel', this.blockWheel, true);
    this.canvas.removeEventListener('keydown', this.onKey);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.snowGeometry.dispose();
    this.renderer.dispose();
  }

  private addSky(): void {
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(118, 32, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        vertexShader: `
          varying vec3 vWorldPosition;
          void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
          }
        `,
        fragmentShader: `
          varying vec3 vWorldPosition;
          void main() {
            vec3 direction = normalize(vWorldPosition);
            float h = direction.y;
            vec3 low = vec3(0.66, 0.40, 0.31);
            vec3 middle = vec3(0.33, 0.39, 0.45);
            vec3 high = vec3(0.075, 0.13, 0.18);
            vec3 color = mix(low, middle, smoothstep(-0.11, 0.39, h));
            color = mix(color, high, smoothstep(0.32, 0.94, h));
            float afterglow = exp(-length(direction - normalize(vec3(-0.48, 0.12, -1.0))) * 4.1);
            color += vec3(0.24, 0.075, 0.024) * afterglow;
            gl_FragColor = vec4(color, 1.0);
          }
        `,
      }),
    );
    sky.frustumCulled = false;
    this.scene.add(sky);
  }

  private addLighting(): void {
    const hemisphere = new THREE.HemisphereLight('#e7b98a', '#202b31', 1.65);
    this.scene.add(hemisphere);

    const sunset = new THREE.DirectionalLight('#ff9a61', 4.4);
    sunset.position.set(-12, 15, -6);
    sunset.castShadow = true;
    sunset.shadow.mapSize.set(1536, 1536);
    sunset.shadow.camera.left = -22;
    sunset.shadow.camera.right = 22;
    sunset.shadow.camera.top = 20;
    sunset.shadow.camera.bottom = -16;
    sunset.shadow.bias = -0.00025;
    this.scene.add(sunset);

    const coolFill = new THREE.DirectionalLight('#9bbbd6', 1.65);
    coolFill.position.set(11, 8, 10);
    this.scene.add(coolFill);

    const cabinGlow = new THREE.PointLight('#ff9b54', 22, 19, 1.7);
    cabinGlow.position.set(-1.2, 2.45, 1.6);
    this.scene.add(cabinGlow);

    const terraceGlow = new THREE.PointLight('#e87b43', 8, 12, 1.8);
    terraceGlow.position.set(4.2, 1.6, 4.5);
    this.scene.add(terraceGlow);

    const sun = new THREE.Mesh(
      new THREE.SphereGeometry(1.7, 32, 24),
      new THREE.MeshBasicMaterial({ color: '#ffad72', toneMapped: false }),
    );
    sun.position.set(-13, 9.2, -17);
    this.scene.add(sun);

    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = 256;
    glowCanvas.height = 256;
    const context = glowCanvas.getContext('2d');
    if (context) {
      const gradient = context.createRadialGradient(128, 128, 4, 128, 128, 126);
      gradient.addColorStop(0, 'rgba(255, 166, 105, 0.52)');
      gradient.addColorStop(0.23, 'rgba(243, 127, 77, 0.25)');
      gradient.addColorStop(0.62, 'rgba(211, 105, 72, 0.075)');
      gradient.addColorStop(1, 'rgba(211, 105, 72, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 256, 256);
    }
    const glowTexture = new THREE.CanvasTexture(glowCanvas);
    glowTexture.colorSpace = THREE.SRGBColorSpace;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: '#ffb380',
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }));
    glow.position.copy(sun.position);
    glow.scale.set(17, 17, 1);
    this.scene.add(glow);
  }

  private addMountains(): void {
    const ridgeLayers = [
      { z: -28, color: '#303b41', y: -0.5, peaks: [[-44, 5], [-36, 9], [-29, 7], [-19, 14], [-10, 10], [0, 16], [11, 9], [22, 13], [32, 8], [44, 12]] },
      { z: -20, color: '#39464d', y: -1.0, peaks: [[-44, 7], [-34, 11], [-25, 8], [-16, 13], [-5, 8], [5, 12], [16, 8], [26, 14], [36, 9], [44, 12]] },
      { z: -12, color: '#4a5559', y: -2.0, peaks: [[-42, 4], [-33, 8], [-24, 5], [-14, 10], [-4, 6], [6, 9], [18, 5], [28, 10], [38, 6], [44, 8]] },
    ];

    ridgeLayers.forEach((layer, index) => {
      const shape = new THREE.Shape();
      shape.moveTo(-48, -3);
      shape.lineTo(-48, layer.peaks[0][1]);
      layer.peaks.forEach(([x, y]) => shape.lineTo(x, y));
      shape.lineTo(48, -3);
      shape.closePath();
      const mountain = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: layer.color, roughness: 1, side: THREE.DoubleSide }),
      );
      mountain.position.set(0, layer.y, layer.z);
      mountain.receiveShadow = true;
      this.scene.add(mountain);

      if (index < 2) {
        layer.peaks.slice(1, -1).forEach(([x, y], peakIndex) => {
          if (peakIndex % 2 === index % 2 && y > 8) {
            const capShape = new THREE.Shape();
            capShape.moveTo(x - 1.55, y - 2.15);
            capShape.lineTo(x, y);
            capShape.lineTo(x + 1.55, y - 2.15);
            capShape.lineTo(x + 0.55, y - 1.67);
            capShape.lineTo(x + 0.08, y - 1.83);
            capShape.lineTo(x - 0.58, y - 1.48);
            capShape.closePath();
            const cap = new THREE.Mesh(
              new THREE.ShapeGeometry(capShape),
              new THREE.MeshBasicMaterial({ color: index === 0 ? '#d9dad1' : '#c8cdd0', side: THREE.DoubleSide }),
            );
            cap.position.set(0, layer.y, layer.z + 0.07);
            this.scene.add(cap);
          }
        });
      }
    });
  }

  private addGround(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 160),
      new THREE.MeshStandardMaterial({ color: '#c8d0d0', roughness: 0.98, metalness: 0.02 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.18;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const driftMaterial = new THREE.MeshStandardMaterial({ color: '#edf0e9', roughness: 1 });
    for (let i = 0; i < 18; i += 1) {
      const drift = new THREE.Mesh(
        new THREE.SphereGeometry(1, 14, 9),
        driftMaterial,
      );
      const x = (i - 9) * 4.4 + Math.sin(i * 2.1) * 1.5;
      const z = -11 + (i % 3) * 7;
      drift.position.set(x, -0.32, z);
      drift.scale.set(3.4 + (i % 4), 0.25 + (i % 3) * 0.1, 2.1 + (i % 2));
      drift.receiveShadow = true;
      this.scene.add(drift);
    }
  }

  private addForest(): void {
    const trunkGeometry = new THREE.CylinderGeometry(0.11, 0.17, 1.45, 6);
    const trunkMaterial = new THREE.MeshStandardMaterial({ color: '#342d27', roughness: 1 });
    const tierGeometry = [
      new THREE.ConeGeometry(1.05, 2.15, 7),
      new THREE.ConeGeometry(0.83, 1.9, 7),
      new THREE.ConeGeometry(0.59, 1.6, 7),
    ];
    const tierMaterials = [
      new THREE.MeshStandardMaterial({ color: '#243438', roughness: 1 }),
      new THREE.MeshStandardMaterial({ color: '#30413f', roughness: 1 }),
      new THREE.MeshStandardMaterial({ color: '#3a4945', roughness: 1 }),
    ];
    const snowMaterial = new THREE.MeshStandardMaterial({ color: '#dbe0db', roughness: 0.94 });
    const placements: Array<[number, number, number, number]> = [
      [-18, -4, 1.1, 0], [-14, -8, 1.35, 0.6], [-11.8, -5, 1.0, 0], [-20, 1, 1.35, 0.3],
      [17, -5, 1.35, 0.5], [14.5, -9, 1.1, 0], [20, 0, 1.5, 0], [12, -6, 0.9, 0.2],
      [-12.5, 7, 1.35, 0], [-8.7, 9, 1.1, 0.3], [12.5, 8, 1.25, 0.4], [16.5, 7, 1.05, 0],
      [-8, -15, 1.1, 0.2], [-3, -17, 1.45, 0], [4.5, -16, 1.2, 0.4], [9, -14, 1.4, 0],
    ];

    placements.forEach(([x, z, scale, rotation], index) => {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeometry, trunkMaterial);
      trunk.position.y = 0.55;
      trunk.castShadow = true;
      tree.add(trunk);
      const tierY = [1.15, 2.02, 2.76];
      tierGeometry.forEach((geometry, tier) => {
        const foliage = new THREE.Mesh(geometry, tierMaterials[(tier + index) % tierMaterials.length]);
        foliage.position.y = tierY[tier];
        foliage.castShadow = true;
        foliage.receiveShadow = true;
        tree.add(foliage);
        if (tier === 1) {
          const snowyTip = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.86, 6), snowMaterial);
          snowyTip.position.y = tierY[tier] + 0.46;
          snowyTip.scale.set(0.92, 0.55, 0.92);
          tree.add(snowyTip);
        }
      });
      tree.position.set(x, -0.1, z);
      tree.scale.setScalar(scale);
      tree.rotation.y = rotation;
      tree.userData.sway = 0.001 + (index % 4) * 0.0004;
      this.scene.add(tree);
    });
  }

  private addCabin(): void {
    const cabin = new THREE.Group();
    const wallMaterial = new THREE.MeshStandardMaterial({ color: '#252c2d', roughness: 0.88, metalness: 0.03 });
    const darkTrim = new THREE.MeshStandardMaterial({ color: '#131a1c', roughness: 0.78, metalness: 0.12 });
    const deckMaterial = new THREE.MeshStandardMaterial({ color: '#514136', roughness: 0.8 });
    const windowMaterial = new THREE.MeshStandardMaterial({
      color: '#f4ac63',
      emissive: '#e4793e',
      emissiveIntensity: 1.45,
      roughness: 0.34,
      metalness: 0.04,
    });

    const deck = new THREE.Mesh(new THREE.BoxGeometry(15.2, 0.36, 9.4), deckMaterial);
    deck.position.set(0, 0.05, 1.25);
    deck.receiveShadow = true;
    deck.castShadow = true;
    cabin.add(deck);

    const planksMaterial = new THREE.MeshStandardMaterial({ color: '#57463a', roughness: 0.91 });
    for (let i = -7; i <= 7; i += 1) {
      const plank = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.018, 9.25), planksMaterial);
      plank.position.set(i, 0.243, 1.25);
      cabin.add(plank);
    }

    const body = new THREE.Mesh(new THREE.BoxGeometry(10.4, 3.65, 6.3), wallMaterial);
    body.position.set(0, 2.22, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    cabin.add(body);

    const gableShape = new THREE.Shape();
    gableShape.moveTo(-5.18, 4.04);
    gableShape.lineTo(5.18, 4.04);
    gableShape.lineTo(0, 5.65);
    gableShape.closePath();
    const gable = new THREE.Mesh(
      new THREE.ShapeGeometry(gableShape),
      new THREE.MeshStandardMaterial({ color: '#242c2e', roughness: 0.9, side: THREE.DoubleSide }),
    );
    gable.position.z = 3.16;
    gable.castShadow = true;
    cabin.add(gable);

    const roofMaterial = new THREE.MeshStandardMaterial({ color: '#171d20', roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide });
    const addRoofSlope = (front: boolean): void => {
      const zEave = front ? 3.54 : -3.54;
      const vertices = front
        ? [-5.55, 4.02, zEave, 5.55, 4.02, zEave, -5.55, 5.7, 0, 5.55, 5.7, 0]
        : [-5.55, 5.7, 0, 5.55, 5.7, 0, -5.55, 4.02, zEave, 5.55, 4.02, zEave];
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geometry.setIndex([0, 2, 1, 2, 3, 1]);
      geometry.computeVertexNormals();
      const slope = new THREE.Mesh(geometry, roofMaterial);
      slope.castShadow = true;
      slope.receiveShadow = true;
      cabin.add(slope);
    };
    addRoofSlope(true);
    addRoofSlope(false);

    const ridge = new THREE.Mesh(new THREE.BoxGeometry(11.3, 0.16, 0.18), darkTrim);
    ridge.position.set(0, 5.7, 0);
    ridge.castShadow = true;
    cabin.add(ridge);

    const roofSnow = new THREE.Mesh(
      new THREE.BoxGeometry(10.9, 0.075, 0.22),
      new THREE.MeshStandardMaterial({ color: '#d9dcd4', roughness: 1 }),
    );
    roofSnow.position.set(0, 4.08, 3.6);
    roofSnow.castShadow = true;
    cabin.add(roofSnow);

    const frontWindows = [-3.45, -1.7, 1.65, 3.45];
    frontWindows.forEach((x, index) => {
      const width = index === 1 || index === 2 ? 1.35 : 1.55;
      const window = new THREE.Mesh(new THREE.BoxGeometry(width, 1.82, 0.08), windowMaterial);
      window.position.set(x, 2.42, 3.205);
      window.castShadow = false;
      cabin.add(window);
      this.addWindowFrame(cabin, x, 2.42, 3.26, width, 1.82, darkTrim);
      const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.82, 0.1), darkTrim);
      mullion.position.set(x, 2.42, 3.28);
      cabin.add(mullion);
    });

    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.08, 2.65, 0.1),
      new THREE.MeshStandardMaterial({ color: '#342c27', roughness: 0.75, metalness: 0.08, emissive: '#8f4d2d', emissiveIntensity: 0.2 }),
    );
    door.position.set(0, 1.67, 3.24);
    cabin.add(door);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 8), new THREE.MeshStandardMaterial({ color: '#c39160', metalness: 0.75, roughness: 0.26 }));
    handle.position.set(0.36, 1.66, 3.32);
    cabin.add(handle);

    const sideWindow = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.55, 2.25), windowMaterial);
    sideWindow.position.set(5.25, 2.38, -0.4);
    cabin.add(sideWindow);
    this.addWindowFrame(cabin, 5.31, 2.38, -0.4, 2.25, 1.55, darkTrim, true);

    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.68, 2.45, 0.7), new THREE.MeshStandardMaterial({ color: '#45433f', roughness: 0.95 }));
    chimney.position.set(3.5, 5.5, -0.7);
    chimney.castShadow = true;
    cabin.add(chimney);
    const chimneyCap = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.14, 0.95), darkTrim);
    chimneyCap.position.set(3.5, 6.78, -0.7);
    cabin.add(chimneyCap);

    const railMaterial = new THREE.MeshStandardMaterial({ color: '#292e2e', roughness: 0.72, metalness: 0.25 });
    const backRail = new THREE.Mesh(new THREE.BoxGeometry(14.2, 0.11, 0.12), railMaterial);
    backRail.position.set(0, 1.15, 5.78);
    cabin.add(backRail);
    for (let i = -6; i <= 6; i += 1) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.11, 1.12, 0.12), railMaterial);
      post.position.set(i, 0.69, 5.78);
      cabin.add(post);
    }
    for (const side of [-1, 1]) {
      const sideRail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.11, 3.4), railMaterial);
      sideRail.position.set(side * 7.05, 1.15, 3.9);
      cabin.add(sideRail);
    }

    const steppingMaterial = new THREE.MeshStandardMaterial({ color: '#c5c9c4', roughness: 0.96 });
    for (let i = 0; i < 5; i += 1) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(2.35 - i * 0.15, 0.18, 0.74), steppingMaterial);
      step.position.set(0, 0.02 + (4 - i) * 0.02, 6.45 + i * 0.62);
      step.castShadow = true;
      cabin.add(step);
    }

    const interior = new THREE.PointLight('#f59b55', 8, 8, 1.9);
    interior.position.set(-0.8, 2.4, 2.4);
    cabin.add(interior);
    cabin.position.y = 0;
    this.scene.add(cabin);
  }

  private addWindowFrame(
    group: THREE.Group,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    material: THREE.Material,
    sideWindow = false,
  ): void {
    const horizontal = new THREE.Mesh(new THREE.BoxGeometry(width + 0.14, 0.09, 0.12), material);
    horizontal.position.set(x, y + height / 2, z);
    group.add(horizontal);
    const horizontalBottom = new THREE.Mesh(new THREE.BoxGeometry(width + 0.14, 0.09, 0.12), material);
    horizontalBottom.position.set(x, y - height / 2, z);
    group.add(horizontalBottom);
    for (const side of [-1, 1]) {
      const vertical = new THREE.Mesh(new THREE.BoxGeometry(0.09, height, 0.12), material);
      vertical.position.set(x + (sideWindow ? 0 : side * (width / 2)), y, z + (sideWindow ? side * (width / 2) : 0));
      group.add(vertical);
    }
  }

  private addHotTub(): void {
    const tub = new THREE.Group();
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#202a2d', roughness: 0.68, metalness: 0.16 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.72, 1.62, 1.08, 44, 1, true), bodyMaterial);
    body.position.y = 0.8;
    body.castShadow = true;
    body.receiveShadow = true;
    tub.add(body);

    const top = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.12, 12, 48), new THREE.MeshStandardMaterial({ color: '#77766c', roughness: 0.58, metalness: 0.23 }));
    top.rotation.x = Math.PI / 2;
    top.position.y = 1.34;
    top.castShadow = true;
    tub.add(top);

    const water = new THREE.Mesh(
      new THREE.CircleGeometry(1.58, 48),
      new THREE.MeshPhysicalMaterial({ color: '#71959a', roughness: 0.21, metalness: 0.13, clearcoat: 0.82, clearcoatRoughness: 0.18, transparent: true, opacity: 0.88 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 1.28;
    tub.add(water);

    const rippleMaterial = new THREE.MeshBasicMaterial({ color: '#d7c6a5', transparent: true, opacity: 0.38, side: THREE.DoubleSide });
    const ripples: THREE.Mesh[] = [];
    for (let i = 0; i < 3; i += 1) {
      const ripple = new THREE.Mesh(new THREE.RingGeometry(0.35 + i * 0.19, 0.38 + i * 0.19, 48), rippleMaterial.clone());
      ripple.rotation.x = -Math.PI / 2;
      ripple.position.set((i - 1) * 0.24, 1.3 + i * 0.002, 0.08 * (i % 2));
      tub.add(ripple);
      ripples.push(ripple);
    }
    tub.userData.ripples = ripples;
    tub.position.set(3.2, 0.25, 4.25);
    this.scene.add(tub);
  }

  private resize(): void {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const mobile = width < 680;
    this.camera.aspect = width / height;
    this.camera.fov = mobile ? 48 : 43;
    this.camera.updateProjectionMatrix();
    if (mobile) {
      this.camera.position.set(0, 10.5, 29);
      this.controls.target.set(0, 2.3, 0);
    } else if (!this.controls.enabled) {
      this.camera.position.copy(this.initialCameraPosition);
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.7));
    this.renderer.setSize(width, height, false);
  }

  private animate = (): void => {
    this.frameId = requestAnimationFrame(this.animate);
    const delta = Math.min(this.clock.getDelta(), 0.04);
    if (this.running) {
      this.elapsed += delta;
      if (this.snowOn) this.updateSnow(delta);
      this.scene.traverse((object) => {
        if (object instanceof THREE.Group && typeof object.userData.sway === 'number') {
          object.rotation.z = Math.sin(this.elapsed * 0.62 + object.position.x) * object.userData.sway;
        }
        if (object.userData.ripples) {
          const ripples = object.userData.ripples as THREE.Mesh[];
          ripples.forEach((ripple, index) => {
            const phase = this.elapsed * 0.75 + index * 2.1;
            const pulse = 0.88 + (Math.sin(phase) + 1) * 0.08;
            ripple.scale.set(pulse, pulse, 1);
            (ripple.material as THREE.MeshBasicMaterial).opacity = 0.15 + (Math.sin(phase) + 1) * 0.08;
          });
        }
      });
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  private updateSnow(delta: number): void {
    for (let i = 0; i < this.snowSpeeds.length; i += 1) {
      const offset = i * 3;
      this.snowPositions[offset + 1] -= this.snowSpeeds[i] * delta;
      this.snowPositions[offset] += Math.sin(this.elapsed * 0.7 + i * 0.11) * delta * 0.14;
      this.snowPositions[offset + 2] += Math.cos(this.elapsed * 0.4 + i * 0.13) * delta * 0.08;
      if (this.snowPositions[offset + 1] < -0.2) {
        this.snowPositions[offset + 1] = 19 + Math.random() * 8;
        this.snowPositions[offset] = (Math.random() - 0.5) * 50;
        this.snowPositions[offset + 2] = (Math.random() - 0.5) * 38;
      }
    }
    this.snowGeometry.attributes.position.needsUpdate = true;
  }
}
