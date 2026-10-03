import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  SECTORS,
  SECTOR_COLORS,
  SECTOR_GAP_DEG,
  SECTOR_LABEL,
  SECTOR_ORDER,
  SPHERE_BAND_W,
  SPHERE_SHELLS,
  buildThreads,
  orbitGlyph,
  sphereFineMix,
  sphereFitDistance,
  sphereGlyphScale,
  sphereHud,
  sphereLod,
  type SphereLod,
  type SphereSeat,
} from '@aegis/glyphs';

/*
 * HULL SPHERE engine — three.js, loaded only when the sphere is opened (dynamic import).
 * Draw calls stay flat whatever the fleet size: one Points haze, two InstancedMesh node sets, two corona Points,
 * two thread LineSegments, a handful of glass shells, lines and label sprites.
 * Renders on demand: camera moves, eases, embers and (at most 30 fps) the capped corona breath. Paused when hidden.
 */

const BANDS = ['dust', '<1k', '1–10k', '10–100k', '100k+'] as const;
const FOV = 30;
const HOME_AZ = 38;
const HOME_EL = 18;
const BREATH_MAX = 64;
const EMBER_MS = 200;
/** The nucleus and the NEAR LIQUIDATION shell breathe together: opacity and a hair of scale, eased, never a flash. */
const NUCLEUS_CYCLE_S = 4;
const NUCLEUS_GLOW = [0.82, 1.12] as const; // alpha multiplier at exhale / inhale
const NUCLEUS_SCALE = 0.012; // ±1.2 % at the peak
/** One thin dim ring at a time is born at the inner shell and falls to the nucleus, fading as it goes. Not aimed at a wallet. */
const FALL_FROM = 0.32;
const FALL_TO = 0.11;
const FALL_S = 3.2;
const FALL_EVERY_S = NUCLEUS_CYCLE_S * 2; // one ring every second breath
const FALL_OPACITY = 0.2;
/** ~30 fps for the breath on desktops, ~20 on phones (a 4 s cycle needs no more) */
const NUCLEUS_FRAME_MS = 33;
const NUCLEUS_FRAME_MS_PHONE = 50;
/** Control feel: around the core, and (gentler, finer) around a framed hull a few hundredths of a unit away. */
const SPEED = { core: { rotate: 0.55, zoom: 0.9, pan: 0.6 }, hull: { rotate: 0.32, zoom: 0.55, pan: 0.3 } } as const;

export interface SphereCallbacks {
  /** HUD line + LOD band, whenever they change */
  onHud(hud: string, lod: SphereLod, pivot: 'CORE' | 'HULL' | 'POINT'): void;
  /** hover (mouse) / first tap (touch): index into the seats, or null */
  onHover(i: number | null, x: number, y: number): void;
  /** click, or second tap on the same ship */
  onOpen(i: number): void;
  /** screen position of the framed ship (for its plate), or null when nothing is framed */
  onFramed(i: number | null, x: number, y: number): void;
  /** frames drawn in the last second while the camera was moving (only with ?fps=1) */
  onFps?(fps: number, drawCalls: number): void;
  /** the camera has come to rest (no drag, no damping, no tween) — a good moment to swap in new data */
  onSettle?(): void;
}

/** Phone budget: full sharpness at rest, cheaper pixels while the camera moves. */
const PHONE_DPR_REST = 1.5;
const PHONE_DPR_MOVING = 1;
/** HUD text updates at most this often while moving (the final value always lands on rest). */
const HUD_EVERY_MS = 150;
/** The camera counts as at rest after this long without movement. */
const REST_MS = 260;

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

type Uniforms = Record<string, { value: unknown }>;

/** Instanced nodes with a global glyph scale, near-fade, fade-in and dim — patched into the standard material. */
function nodeMaterial(u: Uniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.55, metalness: 0.15, transparent: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uGS; uniform float uNear; varying float vNF;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed *= uGS;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvNF = uNear > 0.0 ? smoothstep(uNear * 0.55, uNear, -mvPosition.z) : 1.0;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uAlpha; uniform float uDim; varying float vNF;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= uAlpha * vNF; gl_FragColor.rgb *= uDim;');
  };
  return m;
}

export class SphereEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.005, 60);
  private controls: OrbitControls;
  private w = 1;
  private h = 1;
  private home = 5;
  private raf = 0;
  private dirty = true;
  private lastBreath = 0;
  private lastNucleus = 0;
  private nucleus?: THREE.Mesh;
  private nearShell?: THREE.Mesh;
  private fallRing?: THREE.Mesh;
  private fallT0 = -1;
  /** phones: the falling ring only while frames keep up (smoothed rAF interval, ms) */
  private frameAvg = 16.7;
  private lastRaf = 0;
  private fallOk = true;
  private hudLast = '';
  private lodLast: SphereLod | null = null;
  private pivotLast: 'CORE' | 'HULL' | 'POINT' | null = null;
  /** after a framing ends: the pivot slides back to the core. Not a cancellable tween — wheel/drag can't stop it half-way. */
  private recentering = false;
  private tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number; ms: number } | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private fpsT0 = 0;
  private fpsN = 0;
  /** last time the camera moved (drag, damping, tween, recentring); 0 = at rest */
  private movedAt = 0;
  private moving = false;
  private dprRest = 1;
  private hudAt = 0;
  private hudPending = false;

  private seats: SphereSeat[] = [];
  private glyphIdx: number[] = [];
  private fineIdx: number[] = [];
  private framed: number | null = null;
  private hovered: number | null = null;
  private embers: { idx: number[]; t0: number } | null = null;
  private down: { x: number; y: number; moved: boolean; touch: boolean } | null = null;
  private tapped: number | null = null;

  // shared uniforms
  private uGlyph: Uniforms = { uGS: { value: 1 }, uNear: { value: 0 }, uAlpha: { value: 1 }, uDim: { value: 1 } };
  private uFine: Uniforms = { uGS: { value: 1 }, uNear: { value: 0 }, uAlpha: { value: 0 }, uDim: { value: 1 } };
  private uPx = { value: 1 };
  /** largest haze dot / near-liquidation ring, in device pixels: points never balloon into full-screen fill when you zoom in */
  private uHazeMax = { value: 12 };
  private uRingMax = { value: 80 };
  private uTime = { value: 0 };

  private world = new THREE.Group(); // ships (rebuilt on data change)
  private haze?: THREE.Points;
  private hazeMat: THREE.ShaderMaterial;
  private glyphs?: THREE.InstancedMesh;
  private fine?: THREE.InstancedMesh;
  private coronaG?: THREE.Points;
  private coronaF?: THREE.Points;
  private threadsOrbit?: THREE.LineSegments;
  private threadsNear?: THREE.LineSegments;
  private focusGroup = new THREE.Group();
  private emberPts?: THREE.Points;
  private luneLabels: THREE.Sprite[] = [];
  private shellLabels: THREE.Sprite[] = [];

  private onHostWheel = (e: WheelEvent) => e.preventDefault();

  constructor(
    private host: HTMLElement,
    private cb: SphereCallbacks,
    private opts: { phone: boolean; reduceMotion: boolean },
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x010203);
    this.dprRest = Math.min(window.devicePixelRatio || 1, opts.phone ? PHONE_DPR_REST : 1.5);
    this.renderer.setPixelRatio(this.dprRest);
    this.renderer.domElement.className = 'hs-canvas';
    host.prepend(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, {
      enableDamping: true,
      dampingFactor: 0.085,
      rotateSpeed: SPEED.core.rotate,
      zoomSpeed: SPEED.core.zoom,
      panSpeed: SPEED.core.pan,
      screenSpacePanning: true,
      minDistance: 0.12,
      minPolarAngle: 0.18,
      maxPolarAngle: Math.PI - 0.18,
    });
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    // phones: a pinch only zooms. Two fingers always drift a little, and with pan on that drift slid the pivot off the
    // centre, so the sphere then turned around some other point. The pivot stays on the centre (or the framed wallet).
    if (opts.phone) this.controls.enablePan = false;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener('change', () => this.touch());
    this.controls.addEventListener('start', () => {
      this.tween = null;
    });
    this.controls.addEventListener('end', () => this.scheduleSettle());

    this.hazeMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { size: { value: 0.016 }, px: this.uPx, maxPt: this.uHazeMax, alpha: { value: 0.22 }, nearFade: { value: 0 } },
      vertexShader: `uniform float size; uniform float px; uniform float maxPt; uniform float nearFade; varying vec3 vC; varying float vA;
        void main(){ vC = color; vec4 mv = modelViewMatrix*vec4(position,1.); float d = -mv.z;
          vA = nearFade > 0.0 ? smoothstep(nearFade*0.55, nearFade, d) : 1.0;
          gl_PointSize = clamp(size * px / d, 1.5, maxPt); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform float alpha; varying vec3 vC; varying float vA;
        void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; gl_FragColor = vec4(vC, smoothstep(0.5, 0.0, r) * alpha * vA); }`,
    });

    this.buildStatic();
    this.scene.add(this.world, this.focusGroup);

    const el = this.renderer.domElement;
    // the wheel belongs to the well while the pointer is over it: never scroll the page, even fully zoomed out
    // or mid-drag (OrbitControls skips preventDefault in those cases)
    // on the host box, so the HUD, zoom buttons and plate count as "over the well" too
    host.addEventListener('wheel', this.onHostWheel, { passive: false });
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('dblclick', this.onDbl);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('visibilitychange', this.onVis);
    this.loop(0);
  }

  /* ───────────── static scene: glass, shells, meridians, labels, core ───────────── */

  private glass(radius: number, tint: string, o: { base: number; rim: number; power: number; spec: number; side?: THREE.Side; dark?: number }, order: number) {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(radius, this.opts.phone ? 48 : 96, this.opts.phone ? 32 : 64),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: o.side ?? THREE.FrontSide,
        uniforms: { glow: { value: 1 }, tint: { value: new THREE.Color(tint) }, base: { value: o.base }, rim: { value: o.rim }, power: { value: o.power }, spec: { value: o.spec }, dark: { value: o.dark ?? 0 }, keyDir: { value: new THREE.Vector3(3, 2.4, 2.2).normalize() } },
        vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 w = modelMatrix*vec4(position,1.); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix*viewMatrix*w; }`,
        fragmentShader: `uniform vec3 tint; uniform float base, rim, power, spec, dark, glow; uniform vec3 keyDir; varying vec3 vN; varying vec3 vV;
          void main(){ vec3 n = normalize(vN); if(!gl_FrontFacing) n = -n; float f = pow(1.0 - abs(dot(n, vV)), power);
            float s = pow(max(dot(reflect(-keyDir, n), vV), 0.0), 60.0) * spec;
            vec3 col = mix(tint * (0.35 + f) + vec3(0.8,0.9,1.0) * s, vec3(0.0), dark); gl_FragColor = vec4(col, (base + rim * f + s * 0.6) * glow); }`,
      }),
    );
    m.renderOrder = order;
    return m;
  }

  private buildStatic() {
    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.55));
    const key = new THREE.DirectionalLight(0xcfe8ff, 1.3);
    key.position.set(3, 2.4, 2.2);
    this.scene.add(key);

    this.scene.add(
      this.glass(1.0, '#6fa6b3', { base: 0.035, rim: 0.1, power: 2.0, spec: 0, side: THREE.BackSide }, 1),
      (this.nearShell = this.glass(0.32, '#8a1c24', { base: 0.1, rim: 0.4, power: 2.2, spec: 0.25 }, 3)),
      this.glass(0.54, '#f5c14a', { base: 0, rim: 0.12, power: 3.0, spec: 0 }, 4),
      this.glass(0.84, '#4ce0d2', { base: 0, rim: 0.1, power: 3.2, spec: 0 }, 5),
      this.glass(1.0, '#78bfca', { base: 0.012, rim: 0.42, power: 3.0, spec: 0.55 }, 20),
      (this.nucleus = this.glass(0.11, '#3a0d12', { base: 0.55, rim: 0.35, power: 1.6, spec: 0.1, dark: 0.35 }, 2)), // the nucleus: a dim recessed well
    );
    // the falling ring: a thin circle that always faces the camera, centred on the core
    this.fallRing = new THREE.Mesh(
      new THREE.RingGeometry(0.975, 1, this.opts.phone ? 72 : 128),
      new THREE.MeshBasicMaterial({ color: '#ff6b6b', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.fallRing.renderOrder = 3;
    this.fallRing.visible = false;
    this.scene.add(this.fallRing);

    const P = (r: number, lat: number, lon: number) => new THREE.Vector3(r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat), r * Math.cos(lat) * Math.cos(lon));
    const pts: number[] = [];
    const cols: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Color) => {
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const faint = new THREE.Color(0x2b3a44);
    const tick = new THREE.Color(0x3d525e);
    for (const k of SECTOR_ORDER) {
      const lon = ((SECTORS[k][0] - SECTOR_GAP_DEG / 2) * Math.PI) / 180;
      for (let i = 0; i < 48; i++) seg(P(1, -Math.PI / 2 + (i * Math.PI) / 48, lon), P(1, -Math.PI / 2 + ((i + 1) * Math.PI) / 48, lon), faint);
    }
    for (const latD of [-60, -30, 0, 30, 60]) {
      const lat = (latD * Math.PI) / 180;
      for (let i = 0; i < 144; i++) seg(P(1, lat, (i * Math.PI) / 72), P(1, lat, ((i + 1) * Math.PI) / 72), latD === 0 ? tick : faint);
    }
    for (let d = 0; d < 360; d += 10) seg(P(1, 0, (d * Math.PI) / 180), P(d % 30 === 0 ? 1.045 : 1.025, 0, (d * Math.PI) / 180), tick);
    const bp: number[] = [];
    const bc: number[] = [];
    for (const k of SECTOR_ORDER) {
      const c = new THREE.Color(SECTOR_COLORS[k] === '#6B7280' ? '#9CA3AF' : SECTOR_COLORS[k]);
      const [a0, a1] = SECTORS[k];
      for (let d = a0; d < a1; d += 1) {
        const A = P(1.03, 0, (d * Math.PI) / 180);
        const B = P(1.03, 0, (Math.min(a1, d + 1) * Math.PI) / 180);
        bp.push(A.x, A.y, A.z, B.x, B.y, B.z);
        bc.push(c.r, c.g, c.b, c.r, c.g, c.b);
      }
    }
    const lines = (p: number[], c: number[], opacity: number, order: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false }));
      l.renderOrder = order;
      return l;
    };
    this.scene.add(lines(pts, cols, 0.55, 19), lines(bp, bc, 0.75, 21));

    for (const k of SECTOR_ORDER) {
      const mid = (((SECTORS[k][0] + SECTORS[k][1]) / 2) * Math.PI) / 180;
      const s = this.textSprite(SECTOR_LABEL[k], k === 'OTHER' ? '#9CA3AF' : SECTOR_COLORS[k], 22, 0.22);
      s.position.set(1.12 * Math.sin(mid), 0, 1.12 * Math.cos(mid));
      this.scene.add(s);
      this.luneLabels.push(s);
    }
    for (const sh of SPHERE_SHELLS) {
      const s = this.textSprite(sh.label, sh.color, 20, 0.45);
      s.userData.r = sh.r;
      this.scene.add(s);
      this.shellLabels.push(s);
    }
  }

  private textSprite(text: string, color: string, px: number, spacing: number): THREE.Sprite {
    const c = document.createElement('canvas');
    const x = c.getContext('2d')!;
    const font = `600 ${px}px "IBM Plex Mono", ui-monospace, "DejaVu Sans Mono", monospace`;
    x.font = font;
    const chars = [...text];
    const cw = x.measureText('M').width * (1 + spacing);
    c.width = Math.ceil(chars.length * cw + 16);
    c.height = px + 14;
    x.font = font;
    x.fillStyle = 'rgba(2,3,5,0.78)';
    x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = color;
    x.textBaseline = 'middle';
    chars.forEach((ch, i) => x.fillText(ch, 8 + i * cw, c.height / 2 + 1));
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, depthTest: false }));
    s.userData.aspect = c.width / c.height;
    s.renderOrder = 30;
    return s;
  }

  /* ───────────── ships ───────────── */

  setSeats(seats: SphereSeat[]) {
    // indices change when the live layer adds a ship or one changes pose: keep the framed hull by ADDRESS
    const keepFramed = this.framed !== null ? (this.seats[this.framed]?.address ?? null) : null;
    if (this.framed !== null) this.setFramed(null, true);
    this.hovered = null;
    this.tapped = null;
    this.seats = seats;
    this.clearWorld();
    const phone = this.opts.phone;
    this.glyphIdx = [];
    this.fineIdx = [];
    seats.forEach((s, i) => (orbitGlyph(s, phone) ? this.glyphIdx : this.fineIdx).push(i));

    // haze: every ship, pose-coloured, soft
    const hg = new THREE.BufferGeometry();
    const pos = new Float32Array(seats.length * 3);
    const col = new Float32Array(seats.length * 3);
    const c = new THREE.Color();
    seats.forEach((s, i) => {
      pos[i * 3] = s.x;
      pos[i * 3 + 1] = s.y;
      pos[i * 3 + 2] = s.z;
      c.set(s.color);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    });
    hg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    hg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.haze = new THREE.Points(hg, this.hazeMat);
    this.haze.renderOrder = 8;

    const geo = phone ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, 0);
    this.glyphs = this.nodes(this.glyphIdx, geo, this.uGlyph);
    this.fine = this.nodes(this.fineIdx, geo, this.uFine);
    this.coronaG = this.coronas(this.glyphIdx.filter((i) => seats[i]!.wounded), false, 0.5); // still: no ship pulses on its own
    this.coronaF = this.coronas(this.fineIdx.filter((i) => seats[i]!.wounded), false, 0);

    const orbitSeats = this.glyphIdx.map((i) => seats[i]!);
    this.threadsOrbit = this.threads(orbitSeats, buildThreads(orbitSeats, { k: 3, maxLen: 0.12, cap: phone ? 2000 : 3500 }), 0.26);
    this.world.add(this.haze, this.glyphs, this.fine, this.coronaG, this.coronaF, this.threadsOrbit);
    this.threadsNear = undefined;
    if (keepFramed) {
      const again = seats.findIndex((s) => s.address === keepFramed);
      if (again >= 0) this.setFramed(again); // same hull, new index — the camera does not move
      else this.cb.onFramed(null, 0, 0); // it left the well (e.g. it emptied)
    }
    this.scheduleSettle();
    this.touch();
  }

  /** index of the framed hull, if any */
  framedIndex(): number | null {
    return this.framed;
  }

  private nodes(idx: number[], geo: THREE.BufferGeometry, u: Uniforms): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(geo, nodeMaterial(u), Math.max(1, idx.length));
    m.count = idx.length;
    const M = new THREE.Matrix4();
    const Q = new THREE.Quaternion();
    const E = new THREE.Euler();
    const V = new THREE.Vector3();
    const S = new THREE.Vector3();
    const C = new THREE.Color();
    idx.forEach((si, k) => {
      const s = this.seats[si]!;
      const w = SPHERE_BAND_W[BANDS[s.bandIdx]!];
      E.set(((s.h & 1023) / 1023) * 6.28, (((s.h >>> 10) & 1023) / 1023) * 6.28, 0);
      Q.setFromEuler(E);
      M.compose(V.set(s.x, s.y, s.z), Q, S.set(w, w, w));
      m.setMatrixAt(k, M);
      m.setColorAt(k, C.set(s.color));
    });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
    m.renderOrder = 10;
    return m;
  }

  private coronas(idx: number[], breathe: boolean, strength: number): THREE.Points {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(idx.length * 3);
    const sz = new Float32Array(idx.length);
    const br = new Float32Array(idx.length);
    // the breathing budget goes to a stable set (address hash), never "the closest to death"
    const breathers = new Set(breathe ? [...idx].sort((a, b) => this.seats[a]!.h - this.seats[b]!.h).slice(0, BREATH_MAX) : []);
    idx.forEach((si, k) => {
      const s = this.seats[si]!;
      pos[k * 3] = s.x;
      pos[k * 3 + 1] = s.y;
      pos[k * 3 + 2] = s.z;
      sz[k] = SPHERE_BAND_W[BANDS[s.bandIdx]!];
      br[k] = breathers.has(si) ? 1 : 0;
    });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('sz', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('breath', new THREE.BufferAttribute(br, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { t: this.uTime, px: this.uPx, maxPt: this.uRingMax, gs: this.uGlyph.uGS!, nearFade: this.uGlyph.uNear!, strength: { value: strength }, reduce: { value: this.opts.reduceMotion ? 1 : 0 } },
      vertexShader: `attribute float sz; attribute float breath; uniform float t, px, maxPt, gs, nearFade, reduce; varying float vB; varying float vA;
        void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); float d = -mv.z;
          vA = nearFade > 0.0 ? smoothstep(nearFade*0.55, nearFade, d) : 1.0;
          vB = breath * (1.0 - reduce) * (0.5 + 0.5*sin(t*6.2831853/1.8));
          gl_PointSize = clamp(sz * gs * 3.4 * px / d, 7.0, maxPt) * (1.0 + 0.12*vB); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform float strength; varying float vB; varying float vA;
        void main(){ float r = length(gl_PointCoord - 0.5); float ring = smoothstep(0.5,0.46,r) * smoothstep(0.38,0.42,r); if (ring < 0.01) discard;
          gl_FragColor = vec4(1.0, 0.32, 0.32, ring * (0.7 + 0.3*vB) * vA * strength); }`,
    });
    const p = new THREE.Points(g, mat);
    p.renderOrder = 11;
    p.frustumCulled = false;
    p.userData.breathers = breathers.size;
    return p;
  }

  private threads(list: SphereSeat[], pairs: Array<[number, number]>, opacity: number): THREE.LineSegments {
    const pts = new Float32Array(pairs.length * 6);
    const cols = new Float32Array(pairs.length * 6);
    const c = new THREE.Color();
    pairs.forEach(([i, j], k) => {
      const a = list[i]!;
      const b = list[j]!;
      pts.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6);
      c.set(a.color);
      cols.set([c.r, c.g, c.b, c.r, c.g, c.b], k * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false }));
    l.renderOrder = 9;
    l.frustumCulled = false;
    return l;
  }

  /** TISSUE: short threads among every ship near where you are looking, rebuilt when the camera settles. */
  private rebuildNearThreads() {
    if (this.threadsNear) {
      this.world.remove(this.threadsNear);
      this.threadsNear.geometry.dispose();
      (this.threadsNear.material as THREE.Material).dispose();
      this.threadsNear = undefined;
    }
    const zoom = this.zoom();
    if (zoom < 1.8 && this.framed === null) return;
    const cam = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const tmp = new THREE.Vector3();
    const near: Array<[number, SphereSeat]> = [];
    for (const s of this.seats) {
      tmp.set(s.x, s.y, s.z).sub(cam);
      const d = tmp.length();
      if (tmp.dot(dir) <= 0 || d > 1.4) continue;
      near.push([d, s]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const list = near.slice(0, 3000).map((x) => x[1]);
    this.threadsNear = this.threads(list, buildThreads(list, { k: 2, maxLen: 0.05, cap: this.opts.phone ? 2000 : 4000 }), 0.3);
    this.world.add(this.threadsNear);
    this.touch();
  }

  private clearWorld() {
    for (const o of [...this.world.children]) {
      this.world.remove(o);
      const any = o as THREE.Mesh;
      any.geometry?.dispose();
      const mat = any.material as THREE.Material | undefined;
      if (mat && mat !== this.hazeMat) mat.dispose();
    }
  }

  /* ───────────── camera ───────────── */

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.renderer.setSize(this.w, this.h, false);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
    const first = this.home === 5;
    this.home = sphereFitDistance(FOV, this.camera.aspect, this.opts.phone ? 0.86 : 0.7);
    this.controls.maxDistance = this.home * 1.35;
    this.uPx.value = (this.h * this.renderer.getPixelRatio()) / (2 * Math.tan((FOV * Math.PI) / 360));
    this.pointCaps();
    if (first) this.goHome(false);
    this.touch();
  }

  /** Phones draw fewer pixels while the camera moves and go back to full sharpness once it rests. */
  private setDpr(r: number) {
    if (Math.abs(this.renderer.getPixelRatio() - r) < 0.01) return;
    this.renderer.setPixelRatio(r);
    this.renderer.setSize(this.w, this.h, false);
    this.uPx.value = (this.h * r) / (2 * Math.tan((FOV * Math.PI) / 360));
    this.pointCaps();
    this.dirty = true;
  }

  private pointCaps() {
    const r = this.renderer.getPixelRatio();
    this.uHazeMax.value = (this.opts.phone ? 5 : 9) * r;
    this.uRingMax.value = (this.opts.phone ? 34 : 56) * r;
  }

  /** true while dragging, damping, tweening or recentring */
  isMoving(): boolean {
    return this.moving;
  }

  private zoom() {
    return this.home / Math.max(1e-6, this.camera.position.distanceTo(new THREE.Vector3()));
  }

  private orbitPos(dist: number, azDeg: number, elDeg: number, target = new THREE.Vector3()) {
    const az = (azDeg * Math.PI) / 180;
    const el = (elDeg * Math.PI) / 180;
    return new THREE.Vector3(target.x + dist * Math.cos(el) * Math.sin(az), target.y + dist * Math.sin(el), target.z + dist * Math.cos(el) * Math.cos(az));
  }

  goHome(animate = true) {
    this.setFramed(null);
    this.moveTo(this.orbitPos(this.home, HOME_AZ, HOME_EL), new THREE.Vector3(), animate);
  }

  private moveTo(pos: THREE.Vector3, target: THREE.Vector3, animate: boolean) {
    this.recentering = false;
    if (!animate || this.opts.reduceMotion) {
      this.tween = null;
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      this.scheduleSettle();
      this.touch();
      return;
    }
    // ease-out cubic, no overshoot
    this.tween = { from: [this.camera.position.clone(), this.controls.target.clone()], to: [pos, target], t0: performance.now(), ms: 650 };
    this.touch();
  }

  zoomBy(f: number) {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    const d = THREE.MathUtils.clamp(off.length() / f, this.controls.minDistance, this.controls.maxDistance);
    this.moveTo(t.clone().add(off.setLength(d)), t.clone(), true);
  }

  orbitBy(deg: number) {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t).applyAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180);
    this.moveTo(t.clone().add(off), t.clone(), true);
  }

  /** Frame one hull (Find, double-click, F). null un-frames. */
  frame(i: number | null) {
    this.setFramed(i);
    if (i === null) return;
    const s = this.seats[i]!;
    const p = new THREE.Vector3(s.x, s.y, s.z);
    const out = p.lengthSq() > 1e-6 ? p.clone().normalize() : new THREE.Vector3(0, 0, 1);
    const side = new THREE.Vector3(0, 1, 0).cross(out);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const pos = p.clone().add(out.multiplyScalar(0.19)).add(side.multiplyScalar(0.06)).add(new THREE.Vector3(0, 0.035, 0));
    this.moveTo(pos, p, true);
  }

  /** F: frame the hull under the pointer (or re-frame the current one). false = nothing to frame. */
  frameHovered(): boolean {
    if (this.hovered !== null) this.frame(this.hovered);
    else if (this.framed !== null) this.frame(this.framed);
    else return false;
    return true;
  }

  private setFramed(i: number | null, silent = false) {
    this.framed = i;
    const sp = i === null ? SPEED.core : SPEED.hull;
    Object.assign(this.controls, { rotateSpeed: sp.rotate, zoomSpeed: sp.zoom, panSpeed: sp.pan });
    for (const o of [...this.focusGroup.children]) {
      this.focusGroup.remove(o);
      const any = o as THREE.Mesh;
      any.geometry?.dispose();
      (any.material as THREE.Material | undefined)?.dispose();
    }
    const dim = i === null ? 1 : 0.38;
    this.uGlyph.uDim!.value = dim;
    this.uFine.uDim!.value = dim;
    if (i !== null) {
      const s = this.seats[i]!;
      const geo = this.opts.phone ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, 0);
      const u: Uniforms = { uGS: this.uGlyph.uGS!, uNear: { value: 0 }, uAlpha: { value: 1 }, uDim: { value: 1 } };
      const m = new THREE.InstancedMesh(geo, nodeMaterial(u), 1);
      const w = SPHERE_BAND_W[BANDS[s.bandIdx]!];
      m.setMatrixAt(0, new THREE.Matrix4().compose(new THREE.Vector3(s.x, s.y, s.z), new THREE.Quaternion(), new THREE.Vector3(w, w, w)));
      m.setColorAt(0, new THREE.Color(s.color));
      m.renderOrder = 12;
      this.focusGroup.add(m);
      if (s.wounded) {
        const c = this.coronas([i], false, 1);
        c.renderOrder = 13;
        this.focusGroup.add(c);
      }
      // cyan hairline bracket (decorative frame; no lock-on text)
      const bp: number[] = [];
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) bp.push(sx, sy, 0, sx * 0.55, sy, 0, sx, sy, 0, sx, sy * 0.55, 0);
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
      const br = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: 0x4ce0d2, transparent: true, opacity: 0.9, depthTest: false }));
      br.position.set(s.x, s.y, s.z);
      br.userData.bracket = w;
      br.renderOrder = 40;
      this.focusGroup.add(br);
    }
    if (this.coronaG) (this.coronaG.material as THREE.ShaderMaterial).uniforms.strength!.value = i === null ? 0.5 : 0.38;
    if (i === null && !silent) this.cb.onFramed(null, 0, 0);
    this.touch();
  }

  /** One 200 ms ember on ships that changed live, then still. */
  flash(idx: number[]) {
    if (!idx.length || this.opts.reduceMotion) return;
    if (this.emberPts) {
      this.scene.remove(this.emberPts);
      this.emberPts.geometry.dispose();
      (this.emberPts.material as THREE.Material).dispose();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(idx.flatMap((i) => [this.seats[i]!.x, this.seats[i]!.y, this.seats[i]!.z]), 3));
    const m = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { k: { value: 0 }, px: this.uPx },
      vertexShader: `uniform float k, px; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); gl_PointSize = max(10.0, (0.02 + 0.03*k) * px / -mv.z); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform float k; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; gl_FragColor = vec4(1.0, 0.85, 0.7, (1.0 - k) * smoothstep(0.5, 0.2, r) * 0.8); }`,
    });
    this.emberPts = new THREE.Points(g, m);
    this.emberPts.renderOrder = 14;
    this.scene.add(this.emberPts);
    this.embers = { idx, t0: performance.now() };
    this.touch();
  }

  /* ───────────── input ───────────── */

  private pick(cx: number, cy: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    const ndc = new THREE.Vector2((x / this.w) * 2 - 1, -(y / this.h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin;
    const d = ray.ray.direction;
    const pxPerUnitAt1 = this.h / (2 * Math.tan((FOV * Math.PI) / 360));
    // a ship is under the pointer when the pointer is on its DRAWN glyph (plus a small margin, bigger on touch);
    // of those, the one nearest the camera wins — never a ship hidden behind it
    const pad = this.opts.phone ? 8 : 3;
    const minReach = this.opts.phone ? 12 : 6;
    const gs = this.uGlyph.uGS!.value as number;
    const fineOn = sphereFineMix(this.zoom()) > 0.5 || this.framed !== null;
    const near = (this.uGlyph.uNear!.value as number) * 0.8;
    const hit = (i: number): number | null => {
      const s = this.seats[i]!;
      const vx = s.x - o.x, vy = s.y - o.y, vz = s.z - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t <= Math.max(near, 1e-4)) return null;
      const px = vx - d.x * t, py = vy - d.y * t, pz = vz - d.z * t;
      const dp = (Math.sqrt(px * px + py * py + pz * pz) / t) * pxPerUnitAt1;
      const rPx = ((SPHERE_BAND_W[BANDS[s.bandIdx]!] * gs) / t) * pxPerUnitAt1;
      return dp <= Math.max(rPx + pad, minReach) ? t : null;
    };
    // the framed hull always wins where it is drawn
    if (this.framed !== null && hit(this.framed) !== null) return this.framed;
    let best: number | null = null;
    let bestT = Infinity;
    const test = (i: number) => {
      const t = hit(i);
      if (t !== null && t < bestT) {
        best = i;
        bestT = t;
      }
    };
    for (const i of this.glyphIdx) test(i);
    if (fineOn) for (const i of this.fineIdx) test(i);
    return best;
  }

  private onDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, moved: false, touch: e.pointerType !== 'mouse' };
  };
  private onMove = (e: PointerEvent) => {
    if (this.down) {
      if (Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) this.down.moved = true;
      if (this.down.moved && this.hovered !== null) {
        this.hovered = null;
        this.cb.onHover(null, 0, 0);
      }
      return;
    }
    if (e.pointerType !== 'mouse') return;
    const i = this.pick(e.clientX, e.clientY);
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (i !== this.hovered) {
      this.hovered = i;
      this.touch();
    }
    this.cb.onHover(i, e.clientX - rect.left, e.clientY - rect.top);
  };
  private onUp = (e: PointerEvent) => {
    const d = this.down;
    this.down = null;
    if (!d || d.moved) return;
    const i = this.pick(e.clientX, e.clientY);
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (i === null) {
      this.tapped = null;
      if (d.touch) this.cb.onHover(null, 0, 0);
      return;
    }
    if (d.touch && this.tapped !== i) {
      this.tapped = i; // first tap shows the plate; the second opens the hull
      this.hovered = i;
      this.cb.onHover(i, e.clientX - rect.left, e.clientY - rect.top);
      return;
    }
    this.cb.onOpen(i);
  };
  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') {
      this.hovered = null;
      this.cb.onHover(null, 0, 0);
    }
  };
  private onDbl = (e: MouseEvent) => {
    const i = this.pick(e.clientX, e.clientY);
    if (i !== null) this.frame(i);
    else this.zoomBy(2);
  };
  private onVis = () => {
    if (!document.hidden) this.touch();
  };

  /* ───────────── the nucleus breath ───────────── */

  private breatheNucleus(t: number) {
    // eased 0 → 1 → 0 over one cycle (a raised cosine: slow at both ends, no flash)
    const b = 0.5 - 0.5 * Math.cos((t / NUCLEUS_CYCLE_S) * Math.PI * 2);
    const glow = NUCLEUS_GLOW[0] + (NUCLEUS_GLOW[1] - NUCLEUS_GLOW[0]) * b;
    const sc = 1 + NUCLEUS_SCALE * (b - 0.5) * 2;
    for (const m of [this.nucleus, this.nearShell]) {
      if (!m) continue;
      (m.material as THREE.ShaderMaterial).uniforms.glow!.value = glow;
      m.scale.setScalar(sc);
    }
    const ring = this.fallRing;
    if (!ring) return;
    // phones: the ring only while frames keep up (off under ~42 fps, back on over ~52)
    if (this.opts.phone) {
      if (this.fallOk && this.frameAvg > 24) this.fallOk = false;
      else if (!this.fallOk && this.frameAvg < 19) this.fallOk = true;
    }
    if (!this.fallOk) {
      ring.visible = false;
      this.fallT0 = -1;
      return;
    }
    // one ring at a time, born at the top of every second inhale
    if (this.fallT0 < 0 || t - this.fallT0 > FALL_EVERY_S || t < this.fallT0) this.fallT0 = Math.floor(t / FALL_EVERY_S) * FALL_EVERY_S;
    const k = (t - this.fallT0) / FALL_S;
    if (k < 0 || k >= 1) {
      ring.visible = false;
      return;
    }
    const e = k * k * (3 - 2 * k); // ease in and out
    ring.visible = true;
    ring.scale.setScalar(FALL_FROM + (FALL_TO - FALL_FROM) * e);
    ring.quaternion.copy(this.camera.quaternion);
    // fades in over the first 15 %, out over the last 45 %
    const a = Math.min(1, k / 0.15) * Math.min(1, (1 - k) / 0.45);
    (ring.material as THREE.MeshBasicMaterial).opacity = FALL_OPACITY * a;
  }

  /* ───────────── frame loop (on demand) ───────────── */

  private touch() {
    this.dirty = true;
  }

  private scheduleSettle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.rebuildNearThreads(), 220);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) {
      this.lastRaf = 0;
      return;
    }
    if (this.lastRaf) this.frameAvg += (Math.min(100, now - this.lastRaf) - this.frameAvg) * 0.05;
    this.lastRaf = now;
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(this.tween.from[0], this.tween.to[0], e);
      this.controls.target.lerpVectors(this.tween.from[1], this.tween.to[1], e);
      if (k >= 1) {
        this.tween = null;
        this.scheduleSettle();
      }
      this.dirty = true;
    }
    if (this.recentering && !this.tween) {
      // slide the pivot (and the camera with it) back to the core: the view doesn't swing, the sphere re-centres,
      // and from then on orbit/zoom turn about the same axis as before the search
      const t = this.controls.target;
      if (t.lengthSq() < 1e-8) {
        t.set(0, 0, 0);
        this.recentering = false;
      } else {
        const k = this.opts.reduceMotion ? 1 : 0.2;
        const step = t.clone().multiplyScalar(-k);
        t.add(step);
        this.camera.position.add(step);
        if (t.lengthSq() < 1e-8) {
          t.set(0, 0, 0);
          this.recentering = false;
        }
      }
      this.dirty = true;
    }
    let moved = this.tween !== null || this.recentering;
    if (this.controls.update()) {
      this.dirty = true;
      moved = true;
    }
    if (moved || this.down?.moved) {
      this.movedAt = now;
      if (!this.moving) {
        this.moving = true;
        if (this.opts.phone) this.setDpr(Math.min(this.dprRest, PHONE_DPR_MOVING));
      }
    } else if (this.moving && now - this.movedAt > REST_MS) {
      this.moving = false;
      if (this.opts.phone) this.setDpr(this.dprRest);
      if (this.hudPending) this.dirty = true; // land the final HUD value
      this.cb.onSettle?.();
    }
    if (this.embers) {
      const k = (now - this.embers.t0) / EMBER_MS;
      if (k >= 1 && this.emberPts) {
        this.scene.remove(this.emberPts);
        this.emberPts.geometry.dispose();
        (this.emberPts.material as THREE.Material).dispose();
        this.emberPts = undefined;
        this.embers = null;
      } else if (this.emberPts) (this.emberPts.material as THREE.ShaderMaterial).uniforms.k!.value = k;
      this.dirty = true;
    }
    // the corona breath (≤ 64 rings, 1.8 s) runs at most 30 fps
    const breathing = !this.opts.reduceMotion && ((this.coronaG?.userData.breathers as number) ?? 0) > 0;
    if (breathing && now - this.lastBreath > 33) {
      this.lastBreath = now;
      this.uTime.value = now / 1000;
      this.dirty = true;
    }
    if (!this.opts.reduceMotion && now - this.lastNucleus > (this.opts.phone ? NUCLEUS_FRAME_MS_PHONE : NUCLEUS_FRAME_MS)) {
      this.lastNucleus = now;
      this.breatheNucleus(now / 1000);
      this.dirty = true;
    }
    if (this.cb.onFps && now - this.fpsT0 >= 1000) {
      this.cb.onFps(this.fpsN, this.renderer.info.render.calls);
      this.fpsT0 = now;
      this.fpsN = 0;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.fpsN++;
    this.render();
  };

  private render() {
    if (this.framed !== null && !this.tween && this.camera.position.distanceTo(this.controls.target) > 0.6) {
      // zoomed back out of a framed hull: end the framing and glide the pivot back to the core,
      // so orbit and zoom feel exactly as they did before the search
      this.setFramed(null);
      this.recentering = true;
    }
    const zoom = this.zoom();
    const lod = sphereLod(zoom, this.framed !== null);
    const mix = this.framed !== null ? 1 : sphereFineMix(zoom);
    const gs = sphereGlyphScale(this.framed !== null ? 24 : zoom);
    const dist = this.camera.position.distanceTo(this.controls.target);
    const nearFade = this.framed !== null ? 0.07 : zoom >= 1.8 ? Math.min(0.55, dist * 0.55) : 0;
    this.uGlyph.uGS!.value = gs;
    this.uFine.uGS!.value = gs;
    this.uGlyph.uNear!.value = nearFade;
    this.uFine.uNear!.value = nearFade;
    this.uFine.uAlpha!.value = mix;
    if (this.fine) this.fine.visible = mix > 0.01;
    if (this.coronaF) {
      this.coronaF.visible = mix > 0.01;
      (this.coronaF.material as THREE.ShaderMaterial).uniforms.strength!.value = mix * (this.framed === null ? 1 : 0.38);
    }
    this.hazeMat.uniforms.alpha!.value = zoom >= 1.8 || this.framed !== null ? 0.1 : 0.22;
    // phones: once every wallet is drawn as a glyph the haze adds nothing but fill cost
    if (this.haze) this.haze.visible = !(this.opts.phone && mix >= 0.98);
    this.hazeMat.uniforms.nearFade!.value = nearFade;
    if (this.threadsOrbit) (this.threadsOrbit.material as THREE.LineBasicMaterial).opacity = 0.26 * (1 - mix) + 0.08;
    if (this.threadsNear) (this.threadsNear.material as THREE.LineBasicMaterial).opacity = (this.framed !== null ? 0.22 : 0.3) * mix;

    // labels: lune names ride the equator (front side only); shell names sit at the top of each shell
    const camN = this.camera.position.clone().normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).normalize();
    const lh = (this.opts.phone ? 0.052 : 0.042) / 4.4;
    for (const s of this.luneLabels) {
      const facing = s.position.clone().normalize().dot(camN);
      (s.material as THREE.SpriteMaterial).opacity = zoom < 1.8 && this.framed === null ? THREE.MathUtils.clamp(this.opts.phone ? (facing - 0.45) * 4 : (facing + 0.15) * 2.2, 0, 0.95) : 0;
      const d = this.camera.position.distanceTo(s.position);
      s.scale.set(lh * d * (s.userData.aspect as number), lh * d, 1);
    }
    for (const s of this.shellLabels) {
      const r = s.userData.r as number;
      s.position.copy(up).multiplyScalar(r);
      const d = this.camera.position.distanceTo(s.position);
      const h = ((this.opts.phone ? 0.05 : 0.038) / 4.4) * d * (zoom >= 1.8 ? 1.25 : 1);
      s.scale.set(h * (s.userData.aspect as number), h, 1);
      const behind = this.camera.position.length() < r + 0.05;
      (s.material as THREE.SpriteMaterial).opacity = this.framed !== null || behind ? 0 : zoom >= 1.8 && r > 0.6 ? 0.35 : 0.95;
    }
    // bracket faces the camera
    for (const o of this.focusGroup.children) {
      if (o.userData.bracket) {
        const k = (o.userData.bracket as number) * gs * 5.2;
        o.scale.set(k, k, k);
        o.quaternion.copy(this.camera.quaternion);
      }
    }

    this.renderer.render(this.scene, this.camera);

    // HUD + the framed ship's plate position
    const p = this.camera.position;
    const az = (Math.atan2(p.x, p.z) * 180) / Math.PI;
    const el = (Math.asin(THREE.MathUtils.clamp(p.y / Math.max(p.length(), 1e-6), -1, 1)) * 180) / Math.PI;
    const focus = this.framed ?? this.hovered;
    const hud = sphereHud({ az, el, r: focus !== null ? this.seats[focus]!.r : null, zoom, lod });
    const pivot = this.framed !== null ? 'HULL' : this.controls.target.lengthSq() < 1e-4 ? 'CORE' : 'POINT';
    if (hud !== this.hudLast || lod !== this.lodLast || pivot !== this.pivotLast) {
      // the HUD is React text: while the camera moves it updates a few times a second, not every frame
      const t = performance.now();
      if (!this.moving || lod !== this.lodLast || pivot !== this.pivotLast || t - this.hudAt >= HUD_EVERY_MS) {
        this.hudLast = hud;
        this.lodLast = lod;
        this.pivotLast = pivot;
        this.hudAt = t;
        this.hudPending = false;
        this.cb.onHud(hud, lod, pivot);
      } else this.hudPending = true;
    }
    if (this.framed !== null) {
      const s = this.seats[this.framed]!;
      const v = new THREE.Vector3(s.x, s.y, s.z).project(this.camera);
      this.cb.onFramed(this.framed, (v.x * 0.5 + 0.5) * this.w, (-v.y * 0.5 + 0.5) * this.h);
    }
  }

  /** for the browser checks: what is on screen */
  stats() {
    const i = this.renderer.info.render;
    return { seats: this.seats.length, glyphs: this.glyphIdx.length, calls: i.calls, triangles: i.triangles, points: i.points, lines: i.lines, zoom: this.zoom() };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    if (this.settleTimer) clearTimeout(this.settleTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    this.host.removeEventListener('wheel', this.onHostWheel);
    this.controls.dispose();
    this.clearWorld();
    this.scene.traverse((o) => {
      const any = o as THREE.Mesh;
      any.geometry?.dispose();
      const m = any.material as THREE.Material | THREE.SpriteMaterial | undefined;
      if (m) {
        (m as THREE.SpriteMaterial).map?.dispose();
        m.dispose();
      }
    });
    this.hazeMat.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
