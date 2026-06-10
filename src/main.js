import * as THREE from 'three/webgpu'
import { setupVolumetricLighting, enableLightForVolumetrics } from './volumetric.js'
// ─── Constants ────────────────────────────────────────────────────────────────
const TOWER_SPACING = 5.5
const TOWER_X = [-TOWER_SPACING, 0, TOWER_SPACING]
const TOWER_HEIGHT = 5.5
const TOWER_RADIUS = 0.13
const BASE_TOP_Y = 0.06
const DISK_HEIGHT = 0.42
const DISK_GAP = 0.06
const DISK_MIN_R = 0.7
const DISK_MAX_R = 2.2
const LIFT_Y = TOWER_HEIGHT + 2.0
const LIFT_DUR = 0.22
const DROP_DUR = { across: 0.13, repelAcross: 0.38 }
const GRAVITY = -110
const BOUNCE_RESTITUTION = 0.22
const SQUASH_STIFFNESS = 170
const SQUASH_DAMPING = 11
const DRAG_SPRING_K = 150
const DRAG_SPRING_DAMPING = 0.92 // damping ratio (1 = critically damped)
const DISK_COLORS = [
  0xe74c3c, 0xe67e22, 0xf1c40f,
  0x2ecc71, 0x3498db, 0x9b59b6, 0x1abc9c,
]
// ─── Theme ────────────────────────────────────────────────────────────────────
const THEMES = {
  night: {
    sky: 0x05070d,
    fog: 0x0b1018,
    fogDensity: 0.0065,
    hemi: { sky: 0x3a4a68, ground: 0x1a2030, intensity: 0.42 },
    ambient: { color: 0x243040, intensity: 0.18 },
    key: { color: 0xb8c8e0, intensity: 0.28, position: [-7, 22, -11] },
    moonSpot: { color: 0xc8d8f0, intensity: 0.18, position: [-7, 22, -11], angle: 0.42, penumbra: 0.35 },
    droneSpot: { color: 0xffffff, intensity: 60, angle: Math.PI / 6, penumbra: 0.85, distance: 0, decay: 2 },
    volumetric: { intensity: 1.0, smoke: 1.4 },
    fill: { color: 0x4a5a70, intensity: 0.06, position: [8, 6, 10] },
    terrain: 0x4a4f58,
    tower: 0x6d727a,
    dust: 0x96a0b4,
    exposure: 2.0,
    icon: '☀️', // shown on toggle to switch TO day
  },
  day: {
    scene: 0xd6d3d1, // tailwind stone-300
    fogDensity: 0.0045,
    hemi: { sky: 0xfff0d0, ground: 0x8a8078, intensity: 0.42 },
    ambient: { color: 0xfff0d0, intensity: 0.75 },
    key: { color: 0xfff4dc, intensity: 1.7, position: [5, 12, 8] },
    fill: { color: 0xb8b0a8, intensity: 0.45, position: [-5, 5, -5] },
    terrain: 0xa8a29e, // tailwind stone-400
    tower: 0x57534e, // tailwind stone-600
    dust: 0xc2b9ad,
    exposure: 1.05,
    icon: '🌙', // shown on toggle to switch TO night
  },
}
let currentTheme = 'night'
function pickThemeByTime() {
  const h = new Date().getHours()
  return h >= 6 && h < 18 ? 'day' : 'night'
}
// ─── Audio ── tiny lazy WebAudio synth (no assets) ───────────────────────────
let audioCtx = null
let audioMuted = false
function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)() } catch { return null }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}
function tone({ freq = 440, type = 'sine', dur = 0.15, vol = 0.08, attack = 0.005, sweep = 0, delay = 0 }) {
  const ctx = getAudioCtx()
  // Skip while suspended so queued tones don't burst out on first resume
  if (!ctx || audioMuted || ctx.state !== 'running') return
  const t0 = ctx.currentTime + delay
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t0)
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(freq + sweep, 30), t0 + dur)
  gain.gain.setValueAtTime(0, t0)
  gain.gain.linearRampToValueAtTime(vol, t0 + attack)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + dur + 0.05)
}
const sfx = {
  lift: () => tone({ freq: 340, type: 'triangle', dur: 0.12, vol: 0.05, sweep: 160 }),
  drop: (impact = 1) => {
    tone({ freq: 110 + impact * 50, type: 'sine', dur: 0.18, vol: 0.1 * impact, sweep: -60 })
    tone({ freq: 900, type: 'triangle', dur: 0.04, vol: 0.025 * impact })
  },
  invalid: () => tone({ freq: 160, type: 'sawtooth', dur: 0.18, vol: 0.045, sweep: -40 }),
  win: () => {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5]
    notes.forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.5, vol: 0.06, delay: i * 0.11 }))
  },
}
// ─── Renderer / Scene / Camera ────────────────────────────────────────────────
const canvas = document.getElementById('canvas')
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
let renderPipeline = null
let setVolumetricEnabled = null
let setVolumetricSmoke = null
const scene = new THREE.Scene()
scene.background = new THREE.Color(THEMES.night.sky)
scene.fog = new THREE.FogExp2(THEMES.night.fog, THEMES.night.fogDensity)
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 600)
const cameraTarget = new THREE.Vector3(0, 1.8, 0)
const cameraOffset = new THREE.Vector3(0, 26, 50) // default: max zoom-out over play area
const _camForward = new THREE.Vector3()
const _camRight = new THREE.Vector3()
const _camUp = new THREE.Vector3()
const keys = {}
let isOrbiting = false
let isPanning = false
let orbitLast = { x: 0, y: 0 }
const ORBIT_SENS = 0.004
const PAN_SENS = 0.0012
const ZOOM_SENS = 0.001
const CAMERA_MOVE_SPEED = 9
const CAMERA_PITCH_MIN = 0.12
const CAMERA_PITCH_MAX = 1.35
const CAMERA_DIST_MIN = 8
const CAMERA_DIST_MAX = 75
function updateCamera() {
  camera.position.copy(cameraTarget).add(cameraOffset)
  camera.lookAt(cameraTarget)
}
updateCamera()
// ─── Lighting ─────────────────────────────────────────────────────────────────
const hemiLight = new THREE.HemisphereLight(0x4a5e82, 0x1e2228, 0.62)
scene.add(hemiLight)
const ambientLight = new THREE.AmbientLight(0xffffff, 0.8)
scene.add(ambientLight)
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2)
keyLight.position.set(5, 12, 8)
keyLight.castShadow = true
keyLight.shadow.mapSize.set(2048, 2048)
keyLight.shadow.camera.near = 0.1
keyLight.shadow.camera.far = 40
keyLight.shadow.camera.left = -14
keyLight.shadow.camera.right = 14
keyLight.shadow.camera.top = 14
keyLight.shadow.camera.bottom = -4
keyLight.shadow.bias = -0.001
scene.add(keyLight)
const fillLight = new THREE.DirectionalLight(0xffffff, 0.4)
fillLight.position.set(-5, 5, -5)
scene.add(fillLight)
const moonSpot = new THREE.SpotLight(0xdce8ff, 0, 70, 0.42, 0.35, 1.4)
moonSpot.position.set(-7, 22, -11)
moonSpot.target.position.set(0, 0.8, 0)
moonSpot.castShadow = false
scene.add(moonSpot)
scene.add(moonSpot.target)
const nightSkyGroup = new THREE.Group()
scene.add(nightSkyGroup)
// ─── Alien Sky ── cratered moon + distant Earth: this game isn't played from home
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function makeCanvas(w, h) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  return [cv, cv.getContext('2d')]
}
function canvasToTexture(cv) {
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}
function createEarthTexture() {
  const w = 1024, h = 512
  const [cv, ctx] = makeCanvas(w, h)
  const rand = mulberry32(20260610)
  const ocean = ctx.createLinearGradient(0, 0, 0, h)
  ocean.addColorStop(0, '#33588f')
  ocean.addColorStop(0.5, '#1c5b9e')
  ocean.addColorStop(1, '#33588f')
  ctx.fillStyle = ocean
  ctx.fillRect(0, 0, w, h)
  // Continents — random-walk blob clusters, drawn thrice so they wrap the seam
  const landColors = ['#4d7a45', '#5d8a4a', '#7d7a4a', '#8a7d52']
  for (let c = 0; c < 7; c++) {
    let x = rand() * w
    let y = h * (0.18 + rand() * 0.64)
    const blobs = 60 + Math.floor(rand() * 90)
    ctx.globalAlpha = 0.85
    for (let b = 0; b < blobs; b++) {
      const r = 8 + rand() * 26
      ctx.fillStyle = landColors[Math.floor(rand() * landColors.length)]
      for (const ox of [-w, 0, w]) {
        ctx.beginPath()
        ctx.ellipse(x + ox, y, r * (0.7 + rand() * 0.7), r * (0.5 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2)
        ctx.fill()
      }
      x += (rand() - 0.5) * 52
      y = Math.max(h * 0.1, Math.min(h * 0.9, y + (rand() - 0.5) * 30))
      if (x < 0) x += w
      if (x > w) x -= w
    }
  }
  // Polar ice caps
  ctx.globalAlpha = 1
  for (const top of [true, false]) {
    const capH = h * 0.13
    const g = ctx.createLinearGradient(0, top ? 0 : h, 0, top ? capH : h - capH)
    g.addColorStop(0, 'rgba(245,250,255,0.96)')
    g.addColorStop(1, 'rgba(245,250,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, top ? 0 : h - capH, w, capH)
  }
  return canvasToTexture(cv)
}
function createCloudTexture() {
  const w = 1024, h = 512
  const [cv, ctx] = makeCanvas(w, h)
  const rand = mulberry32(99)
  ctx.fillStyle = '#ffffff'
  for (let i = 0; i < 90; i++) {
    const x = rand() * w
    const y = h * (0.08 + rand() * 0.84)
    const len = 30 + rand() * 120
    const segs = 4 + Math.floor(rand() * 7)
    ctx.globalAlpha = 0.1 + rand() * 0.22
    for (let s = 0; s < segs; s++) {
      const sx = x + (s / segs) * len
      const sy = y + (rand() - 0.5) * 14
      const r = 9 + rand() * 22
      for (const ox of [-w, 0, w]) {
        ctx.beginPath()
        ctx.ellipse(sx + ox, sy, r * 1.6, r * 0.55, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.globalAlpha = 1
  return canvasToTexture(cv)
}
function createMoonTexture() {
  const w = 512, h = 256
  const [cv, ctx] = makeCanvas(w, h)
  const rand = mulberry32(42)
  ctx.fillStyle = '#c9cdd8'
  ctx.fillRect(0, 0, w, h)
  // Maria — large dark basalt patches
  for (let i = 0; i < 14; i++) {
    ctx.globalAlpha = 0.1 + rand() * 0.12
    ctx.fillStyle = '#8e94a4'
    ctx.beginPath()
    ctx.ellipse(rand() * w, 40 + rand() * (h - 80), 20 + rand() * 60, 14 + rand() * 40, rand() * Math.PI, 0, Math.PI * 2)
    ctx.fill()
  }
  // Craters — dark floor with an offset bright rim
  for (let i = 0; i < 80; i++) {
    const x = rand() * w
    const y = 14 + rand() * (h - 28)
    const r = 1.5 + rand() * 9
    ctx.globalAlpha = 0.25 + rand() * 0.3
    ctx.fillStyle = '#9aa0b0'
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#e6eaf2'
    ctx.beginPath()
    ctx.arc(x - r * 0.25, y - r * 0.25, r * 0.55, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
  return canvasToTexture(cv)
}
// Shared "sun" so the moon and Earth phases agree
const PLANET_SUN_DIR = new THREE.Vector3(-0.7, 0.28, 0.6).normalize()
// 0..1 master fade for moon/Earth/stars — animated by the theme transition
const skyFadeUniform = THREE.TSL.uniform(1)
function planetDayAmount(wrap) {
  const { uniform, normalWorld } = THREE.TSL
  return normalWorld.normalize().dot(uniform(PLANET_SUN_DIR)).mul(0.5).add(0.5).pow(wrap)
}
// Unlit node material with baked wrapped day/night terminator + optional atmosphere rim
function createPlanetMaterial(map, { nightDim = 0.05, wrap = 1.3, boost = 1.15, rim = null } = {}) {
  const { texture, normalWorld, positionWorld, cameraPosition, vec3, float } = THREE.TSL
  const mat = new THREE.MeshBasicNodeMaterial({ fog: false, transparent: true })
  mat.opacityNode = skyFadeUniform
  const day = planetDayAmount(wrap)
  let color = texture(map).rgb.mul(day.mul(boost).add(nightDim))
  if (rim) {
    const viewDir = cameraPosition.sub(positionWorld).normalize()
    const fres = float(1).sub(normalWorld.normalize().dot(viewDir).clamp(0, 1)).pow(2.8)
    color = color.add(vec3(...rim).mul(fres).mul(day.add(0.2)))
  }
  mat.colorNode = color
  return mat
}
// Additive back-face shell — soft glow extending past the limb
function createHaloMesh(radius, colorHex, power, strength) {
  const { normalWorld, positionWorld, cameraPosition, color } = THREE.TSL
  const mat = new THREE.MeshBasicNodeMaterial({
    fog: false,
    transparent: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const viewDir = cameraPosition.sub(positionWorld).normalize()
  const limb = normalWorld.normalize().dot(viewDir).add(1).clamp(0, 1).pow(power)
  mat.colorNode = color(colorHex).mul(limb.mul(strength)).mul(skyFadeUniform)
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat)
}
const MOON_RADIUS = 4.2
const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(MOON_RADIUS, 48, 32),
  createPlanetMaterial(createMoonTexture(), { nightDim: 0.12, wrap: 0.8, boost: 1.2 }),
)
moonMesh.add(createHaloMesh(MOON_RADIUS * 1.3, 0xdce8ff, 6, 0.5))
nightSkyGroup.add(moonMesh)
const EARTH_RADIUS = 30
const earthMesh = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS, 64, 48),
  createPlanetMaterial(createEarthTexture(), { boost: 0.85, nightDim: 0.04, rim: [0.18, 0.33, 0.7] }),
)
const cloudMat = new THREE.MeshBasicNodeMaterial({ fog: false, transparent: true, depthWrite: false })
cloudMat.colorNode = THREE.TSL.vec3(1, 1, 1).mul(planetDayAmount(1.1).mul(0.85).add(0.05))
cloudMat.opacityNode = THREE.TSL.texture(createCloudTexture()).a.mul(0.85).mul(skyFadeUniform)
const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * 1.012, 64, 48), cloudMat)
const earthTilt = new THREE.Group()
earthTilt.rotation.z = 0.2
earthTilt.add(earthMesh, cloudMesh, createHaloMesh(EARTH_RADIUS * 1.16, 0x4d7dff, 5, 0.65))
nightSkyGroup.add(earthTilt)
// World-fixed, centered behind the middle tower: from the default view the
// composition reads tower → middle tower → Earth, straight down the z axis.
const EARTH_DIST = 260
const EARTH_ELEV = 0.24 // rad above the horizon — high enough to clear the hills
earthTilt.position.set(
  TOWER_X[1],
  Math.sin(EARTH_ELEV) * EARTH_DIST,
  -Math.cos(EARTH_ELEV) * EARTH_DIST,
)
function tickEarth(delta) {
  if (!nightSkyGroup.visible) return
  earthMesh.rotation.y += delta * 0.012
  cloudMesh.rotation.y += delta * 0.018
}
function buildStarField(count = 1400) {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  const radius = 290
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.random() * Math.PI * 0.38 + 0.1
    const r = radius * (0.92 + Math.random() * 0.08)
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = r * Math.cos(phi)
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    const b = 0.55 + Math.random() * 0.45
    const tint = Math.random()
    colors[i * 3] = b * (0.88 + tint * 0.1)
    colors[i * 3 + 1] = b * (0.9 + tint * 0.06)
    colors[i * 3 + 2] = b
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({
      size: 1.1,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      fog: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  )
}
const starField = buildStarField()
nightSkyGroup.add(starField)
nightSkyGroup.visible = false
// Minimal procedural quadcopter — no external model (CC-free, tiny footprint)
function buildDrone() {
  const rig = new THREE.Group()
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2e333c, roughness: 0.55, metalness: 0.35 })
  const rotorMat = new THREE.MeshStandardMaterial({
    color: 0x15181e, transparent: true, opacity: 0.4, roughness: 0.9,
  })
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x8ab4e8, emissive: 0x3a5a88, emissiveIntensity: 0.55,
  })
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0xf4faff, emissive: 0xd0e8ff, emissiveIntensity: 1.6,
  })
  rig.add(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.14, 0.52), bodyMat))
  for (let i = 0; i < 4; i++) {
    const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.05, 0.5), bodyMat)
    arm.position.set(Math.sin(angle) * 0.14, 0, Math.cos(angle) * 0.14)
    arm.rotation.y = angle
    rig.add(arm)
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.07, 6), bodyMat)
    motor.position.set(Math.sin(angle) * 0.36, 0.05, Math.cos(angle) * 0.36)
    rig.add(motor)
    const prop = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.015, 6), rotorMat)
    prop.position.set(motor.position.x, 0.1, motor.position.z)
    prop.userData.propeller = true
    prop.userData.spinDir = i % 2 === 0 ? 1 : -1
    rig.add(prop)
  }
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 8), lensMat)
  cam.position.y = -0.12
  rig.add(cam)
  const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 0.09, 8), lampMat)
  lamp.position.y = -0.22
  rig.add(lamp)
  return rig
}
const DRONE_COUNT = 3
const DRONE_SWARM = {
  bounds: { x: [-15, 15], z: [-11, 11], y: [9, 16.5] },
  minSeparation: 2.0,
  maxSpeed: 4.2,
  wanderStrength: 0.72,
  separationStrength: 3.2,
  edgeStrength: 0.95,
  driftStrength: 0.85,
  damping: 0.94,
}
const droneGroup = new THREE.Group()
const drones = []
const _droneSep = new THREE.Vector3()
function pickDroneWanderTarget(drone) {
  const { bounds } = DRONE_SWARM
  drone.wanderX = THREE.MathUtils.lerp(bounds.x[0], bounds.x[1], Math.random())
  drone.wanderZ = THREE.MathUtils.lerp(bounds.z[0], bounds.z[1], Math.random())
  drone.wanderY = THREE.MathUtils.lerp(bounds.y[0], bounds.y[1], Math.random())
  drone.nextWanderAt = performance.now() * 0.001 + THREE.MathUtils.lerp(4.5, 11, Math.random())
}
for (let i = 0; i < DRONE_COUNT; i++) {
  const rig = new THREE.Group()
  rig.add(buildDrone())
  const spot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI / 6, 0.85, 2)
  spot.position.set(0, -0.25, 0)
  spot.castShadow = true
  spot.shadow.intensity = 0.98
  spot.shadow.mapSize.set(512, 512)
  spot.shadow.camera.near = 1
  spot.shadow.camera.far = 30
  spot.shadow.focus = 1
  rig.add(spot)
  const spotTarget = new THREE.Object3D()
  spotTarget.position.set(0, -11, 0) // aim straight down from drone to ground below
  rig.add(spotTarget)
  spot.target = spotTarget
  droneGroup.add(rig)
  const spread = (i / DRONE_COUNT) * Math.PI * 2
  const drone = {
    rig,
    spot,
    spotTarget,
    x: Math.sin(spread) * 10,
    z: Math.cos(spread) * 7,
    y: 11.5 + i * 0.8,
    vx: Math.sin(spread) * 0.6,
    vz: Math.cos(spread) * 0.6,
    vy: 0,
    wanderX: 0,
    wanderZ: 0,
    wanderY: 12,
    driftPhase: spread + i * 1.7,
    nextWanderAt: 0,
  }
  pickDroneWanderTarget(drone)
  drones.push(drone)
}
scene.add(droneGroup)
droneGroup.visible = false
const volumetricLights = [moonSpot, ...drones.map((d) => d.spot)]
let terrainMesh = null
const towerMaterials = [] // collected during buildScene so applyTheme can recolor them
function applyTheme(name) {
  currentTheme = name
  const t = THEMES[name]
  const isNight = name === 'night'
  scene.background.setHex(t.sky ?? t.scene)
  if (isNight && renderPipeline) {
    scene.fog = null
  } else {
    if (!scene.fog) scene.fog = new THREE.FogExp2(t.fog ?? t.sky ?? t.scene, t.fogDensity)
    scene.fog.color.setHex(t.fog ?? t.sky ?? t.scene)
    scene.fog.density = t.fogDensity
  }
  if (t.hemi) {
    hemiLight.color.setHex(t.hemi.sky)
    hemiLight.groundColor.setHex(t.hemi.ground)
    hemiLight.intensity = t.hemi.intensity
  }
  ambientLight.color.setHex(t.ambient.color)
  ambientLight.intensity = t.ambient.intensity
  keyLight.color.setHex(t.key.color)
  keyLight.intensity = t.key.intensity
  if (t.key.position) keyLight.position.set(...t.key.position)
  fillLight.color.setHex(t.fill.color)
  fillLight.intensity = t.fill.intensity
  if (t.fill.position) fillLight.position.set(...t.fill.position)
  if (t.moonSpot) {
    moonSpot.visible = isNight
    moonSpot.color.setHex(t.moonSpot.color)
    moonSpot.intensity = isNight ? t.moonSpot.intensity : 0
    moonSpot.angle = t.moonSpot.angle
    moonSpot.penumbra = t.moonSpot.penumbra
    moonSpot.position.set(...t.moonSpot.position)
    moonSpot.target.position.set(0, 0.8, 0)
    moonSpot.target.updateMatrixWorld()
    const moonPos = new THREE.Vector3(...t.moonSpot.position).normalize().multiplyScalar(210)
    moonPos.y = Math.max(moonPos.y, 95)
    moonMesh.position.copy(moonPos)
  } else {
    moonSpot.visible = false
    moonSpot.intensity = 0
  }
  nightSkyGroup.visible = isNight
  droneGroup.visible = isNight
  skyFadeUniform.value = isNight ? 1 : 0
  starField.material.opacity = isNight ? 0.9 : 0
  volumetricLevel = isNight ? (t.volumetric?.intensity ?? 1.0) : 0
  if (setVolumetricEnabled) {
    setVolumetricEnabled(isNight, volumetricLevel)
  }
  if (setVolumetricSmoke && t.volumetric) setVolumetricSmoke(t.volumetric.smoke)
  if (renderPipeline) {
    for (const light of volumetricLights) enableLightForVolumetrics(light, isNight)
  }
  renderer.toneMapping = isNight ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
  for (const { spot } of drones) {
    if (t.droneSpot) {
      spot.color.setHex(t.droneSpot.color)
      spot.intensity = isNight ? t.droneSpot.intensity : 0
      spot.angle = t.droneSpot.angle
      spot.penumbra = t.droneSpot.penumbra
      if (t.droneSpot.distance != null) spot.distance = t.droneSpot.distance
      if (t.droneSpot.decay != null) spot.decay = t.droneSpot.decay
    } else {
      spot.intensity = 0
    }
  }
  renderer.toneMappingExposure = t.exposure
  if (terrainMesh) terrainMesh.material.color.setHex(t.terrain)
  for (const m of towerMaterials) m.color.setHex(t.tower)
  document.body.classList.toggle('light', name === 'day')
  const tog = document.getElementById('theme-toggle')
  if (tog) tog.textContent = t.icon
}
// ─── Theme Transition ── crossfade the whole world instead of hard-cutting ───
const THEME_TRANSITION_DUR = 1.8
let themeTransition = null // { t, to, from, targets, mid }
let volumetricLevel = 0
function snapshotThemeState() {
  return {
    sky: scene.background.clone(),
    fogColor: scene.fog ? scene.fog.color.clone() : new THREE.Color(THEMES.night.fog),
    fogDensity: scene.fog ? scene.fog.density : THEMES.night.fogDensity,
    hemiSky: hemiLight.color.clone(),
    hemiGround: hemiLight.groundColor.clone(),
    hemiInt: hemiLight.intensity,
    ambColor: ambientLight.color.clone(),
    ambInt: ambientLight.intensity,
    keyColor: keyLight.color.clone(),
    keyInt: keyLight.intensity,
    keyPos: keyLight.position.clone(),
    fillColor: fillLight.color.clone(),
    fillInt: fillLight.intensity,
    fillPos: fillLight.position.clone(),
    moonInt: moonSpot.intensity,
    droneInt: drones[0]?.spot.intensity ?? 0,
    exposure: renderer.toneMappingExposure,
    terrain: terrainMesh ? terrainMesh.material.color.clone() : new THREE.Color(),
    tower: towerMaterials[0] ? towerMaterials[0].color.clone() : new THREE.Color(),
    skyFade: skyFadeUniform.value,
    volumetric: volumetricLevel,
  }
}
function themeTargets(name) {
  const t = THEMES[name]
  const isNight = name === 'night'
  return {
    sky: new THREE.Color(t.sky ?? t.scene),
    fogColor: new THREE.Color(t.fog ?? t.sky ?? t.scene),
    fogDensity: t.fogDensity,
    hemiSky: new THREE.Color(t.hemi.sky),
    hemiGround: new THREE.Color(t.hemi.ground),
    hemiInt: t.hemi.intensity,
    ambColor: new THREE.Color(t.ambient.color),
    ambInt: t.ambient.intensity,
    keyColor: new THREE.Color(t.key.color),
    keyInt: t.key.intensity,
    keyPos: new THREE.Vector3(...t.key.position),
    fillColor: new THREE.Color(t.fill.color),
    fillInt: t.fill.intensity,
    fillPos: new THREE.Vector3(...t.fill.position),
    moonInt: isNight && t.moonSpot ? t.moonSpot.intensity : 0,
    droneInt: isNight && t.droneSpot ? t.droneSpot.intensity : 0,
    exposure: t.exposure,
    terrain: new THREE.Color(t.terrain),
    tower: new THREE.Color(t.tower),
    skyFade: isNight ? 1 : 0,
    volumetric: isNight ? (t.volumetric?.intensity ?? 1.0) : 0,
  }
}
function startThemeTransition(name) {
  if (currentTheme === name && !themeTransition) return
  const from = snapshotThemeState()
  currentTheme = name
  // Everything that fades must be visible for the duration; applyTheme at the
  // end settles the final visibility flags.
  nightSkyGroup.visible = true
  droneGroup.visible = true
  moonSpot.visible = true
  if (!scene.fog) scene.fog = new THREE.FogExp2(from.fogColor.getHex(), from.fogDensity)
  themeTransition = { t: 0, to: name, from, targets: themeTargets(name), mid: false }
  const tog = document.getElementById('theme-toggle')
  if (tog) tog.textContent = THEMES[name].icon
}
function tickThemeTransition(delta) {
  if (!themeTransition) return
  const tr = themeTransition
  tr.t += delta / THEME_TRANSITION_DUR
  const p = easeInOut(Math.min(tr.t, 1))
  const a = tr.from
  const b = tr.targets
  const lerp = THREE.MathUtils.lerp
  scene.background.copy(a.sky).lerp(b.sky, p)
  if (scene.fog) {
    scene.fog.color.copy(a.fogColor).lerp(b.fogColor, p)
    scene.fog.density = lerp(a.fogDensity, b.fogDensity, p)
  }
  hemiLight.color.copy(a.hemiSky).lerp(b.hemiSky, p)
  hemiLight.groundColor.copy(a.hemiGround).lerp(b.hemiGround, p)
  hemiLight.intensity = lerp(a.hemiInt, b.hemiInt, p)
  ambientLight.color.copy(a.ambColor).lerp(b.ambColor, p)
  ambientLight.intensity = lerp(a.ambInt, b.ambInt, p)
  keyLight.color.copy(a.keyColor).lerp(b.keyColor, p)
  keyLight.intensity = lerp(a.keyInt, b.keyInt, p)
  keyLight.position.lerpVectors(a.keyPos, b.keyPos, p)
  fillLight.color.copy(a.fillColor).lerp(b.fillColor, p)
  fillLight.intensity = lerp(a.fillInt, b.fillInt, p)
  fillLight.position.lerpVectors(a.fillPos, b.fillPos, p)
  moonSpot.intensity = lerp(a.moonInt, b.moonInt, p)
  for (const d of drones) d.spot.intensity = lerp(a.droneInt, b.droneInt, p)
  renderer.toneMappingExposure = lerp(a.exposure, b.exposure, p)
  if (terrainMesh) terrainMesh.material.color.copy(a.terrain).lerp(b.terrain, p)
  for (const m of towerMaterials) m.color.copy(a.tower).lerp(b.tower, p)
  skyFadeUniform.value = lerp(a.skyFade, b.skyFade, p)
  starField.material.opacity = 0.9 * skyFadeUniform.value
  volumetricLevel = lerp(a.volumetric, b.volumetric, p)
  if (setVolumetricEnabled) setVolumetricEnabled(volumetricLevel > 0.002, volumetricLevel)
  // Discrete switches (tone mapper, CSS palette) — at the midpoint, masked by motion
  if (!tr.mid && p >= 0.5) {
    tr.mid = true
    renderer.toneMapping = tr.to === 'night' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping
    document.body.classList.toggle('light', tr.to === 'day')
  }
  if (tr.t >= 1) {
    themeTransition = null
    applyTheme(tr.to) // settle exact values + visibility flags
  }
}
// ─── Game State ───────────────────────────────────────────────────────────────
let NUM_DISKS = 4
let stacks = [[], [], []]
let moves = 0
let gameWon = false
// Drag state — lives only while user has mouse button held
let dragInfo = null // { diskSize, fromTower, stackPos, targetX, bobT }
let isDragging = false // disk actively follows mouse (after lift completes)
let liftAnim = null // { t, startY }
// Post-release animation
let dropAnim = null // { type:'valid'|'repel'|'return', phase:'across'|'fall', ... }
let animating = false // drop/repel/intro running — block new interactions
// Per-disk animation FX — squash & stretch spring + velocity tilt
const diskFX = {} // size -> { squash, squashV, vx, tilt, lastX }
let introAnims = [] // staggered drop-in at game start
const fxQueue = [] // { at, size, impulse } — delayed squash pulses (impact waves)
let clockTime = 0
let shakeAmp = 0
// ─── Scene Objects ────────────────────────────────────────────────────────────
const gameGroup = new THREE.Group()
scene.add(gameGroup)
const diskMeshes = {} // size -> Mesh
const clickZones = [] // [0,1,2] invisible hit cylinders
const ringMeshes = [] // [0,1,2] selection/feedback rings
// ─── Helpers ─────────────────────────────────────────────────────────────────
function getDiskRadius(size) {
  if (NUM_DISKS === 1) return DISK_MAX_R
  return DISK_MIN_R + (size - 1) / (NUM_DISKS - 1) * (DISK_MAX_R - DISK_MIN_R)
}
function getDiskY(stackPos) {
  return BASE_TOP_Y + DISK_HEIGHT / 2 + stackPos * (DISK_HEIGHT + DISK_GAP)
}
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}
// Ease-out with overshoot — gives the spring/repel feel
function easeOutBack(t, s = 2.8) {
  const u = t - 1
  return u * u * ((s + 1) * u + s) + 1
}
// Project disk center and each tower center to screen space, pick closest tower.
// Avoids the parallax error from comparing world X at LIFT_Y vs world X at ground.
const _projVec = new THREE.Vector3()
function screenX(worldPos) {
  _projVec.copy(worldPos)
  _projVec.project(camera)
  return (_projVec.x + 1) * 0.5 * window.innerWidth
}
// Compare mouse screen X against each tower's projected screen X — no world-space parallax.
function getNearestTowerToClient(clientX) {
  let best = 0, bestDist = Infinity
  for (let i = 0; i < 3; i++) {
    _projVec.set(TOWER_X[i], TOWER_HEIGHT * 0.5, 0)
    const d = Math.abs(clientX - screenX(_projVec))
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}
// ─── Particles ────────────────────────────────────────────────────────────────
const _pDummy = new THREE.Object3D()
const _pColor = new THREE.Color()
function createParticlePool(count, geometry, material) {
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.castShadow = false
  mesh.receiveShadow = false
  _pDummy.position.set(0, -100, 0)
  _pDummy.rotation.set(0, 0, 0)
  _pDummy.scale.setScalar(0.0001)
  _pDummy.updateMatrix()
  const parts = []
  for (let i = 0; i < count; i++) {
    mesh.setMatrixAt(i, _pDummy.matrix)
    mesh.setColorAt(i, _pColor.set(0xffffff))
    parts.push({ alive: false, age: 0, life: 1, size: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: false, rx: 0, ry: 0, rz: 0, rvx: 0, rvy: 0, rvz: 0 })
  }
  mesh.instanceMatrix.needsUpdate = true
  scene.add(mesh)
  return { mesh, parts, cursor: 0, dirty: false }
}
const dustPool = createParticlePool(
  160,
  new THREE.IcosahedronGeometry(0.05, 0),
  new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 }),
)
const confettiPool = createParticlePool(
  240,
  new THREE.BoxGeometry(0.11, 0.02, 0.07),
  new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
)
function spawnDust(x, y, z, radius, count, strength) {
  for (let n = 0; n < count; n++) {
    const i = dustPool.cursor
    dustPool.cursor = (dustPool.cursor + 1) % dustPool.parts.length
    const p = dustPool.parts[i]
    const a = Math.random() * Math.PI * 2
    const speed = (1.1 + Math.random() * 1.8) * strength
    p.alive = true
    p.age = 0
    p.life = 0.45 + Math.random() * 0.4
    p.size = 0.7 + Math.random() * 0.9
    p.x = x + Math.cos(a) * radius * 0.92
    p.y = y + Math.random() * 0.06
    p.z = z + Math.sin(a) * radius * 0.92
    p.vx = Math.cos(a) * speed
    p.vz = Math.sin(a) * speed
    p.vy = 0.5 + Math.random() * 1.3 * strength
    p.spin = false
    dustPool.mesh.setColorAt(i, _pColor.setHex(THEMES[currentTheme].dust))
  }
  dustPool.mesh.instanceColor.needsUpdate = true
}
function spawnConfetti(x, y, z, count) {
  for (let n = 0; n < count; n++) {
    const i = confettiPool.cursor
    confettiPool.cursor = (confettiPool.cursor + 1) % confettiPool.parts.length
    const p = confettiPool.parts[i]
    const a = Math.random() * Math.PI * 2
    const horiz = 1 + Math.random() * 3.2
    p.alive = true
    p.age = 0
    p.life = 1.7 + Math.random() * 0.9
    p.size = 0.8 + Math.random() * 0.8
    p.x = x + (Math.random() - 0.5) * 0.5
    p.y = y + (Math.random() - 0.5) * 0.3
    p.z = z + (Math.random() - 0.5) * 0.5
    p.vx = Math.cos(a) * horiz
    p.vz = Math.sin(a) * horiz
    p.vy = 5 + Math.random() * 6.5
    p.spin = true
    p.rx = Math.random() * Math.PI * 2
    p.ry = Math.random() * Math.PI * 2
    p.rz = Math.random() * Math.PI * 2
    p.rvx = (Math.random() - 0.5) * 18
    p.rvy = (Math.random() - 0.5) * 18
    p.rvz = (Math.random() - 0.5) * 18
    confettiPool.mesh.setColorAt(i, _pColor.setHex(DISK_COLORS[Math.floor(Math.random() * DISK_COLORS.length)]))
  }
  confettiPool.mesh.instanceColor.needsUpdate = true
}
function tickPool(pool, delta, gravity, drag) {
  const damp = Math.exp(-drag * delta)
  let any = false
  for (let i = 0; i < pool.parts.length; i++) {
    const p = pool.parts[i]
    if (!p.alive) continue
    any = true
    p.age += delta
    if (p.age >= p.life) {
      p.alive = false
      _pDummy.position.set(0, -100, 0)
      _pDummy.scale.setScalar(0.0001)
      _pDummy.updateMatrix()
      pool.mesh.setMatrixAt(i, _pDummy.matrix)
      continue
    }
    p.vx *= damp
    p.vz *= damp
    p.vy = p.vy * damp + gravity * delta
    p.x += p.vx * delta
    p.y += p.vy * delta
    p.z += p.vz * delta
    if (p.y < 0.03) { p.y = 0.03; p.vy *= -0.3 }
    const fade = Math.min(1, (p.life - p.age) / (p.life * 0.35))
    _pDummy.position.set(p.x, p.y, p.z)
    if (p.spin) {
      p.rx += p.rvx * delta
      p.ry += p.rvy * delta
      p.rz += p.rvz * delta
      _pDummy.rotation.set(p.rx, p.ry, p.rz)
    } else {
      _pDummy.rotation.set(0, 0, 0)
    }
    _pDummy.scale.setScalar(p.size * fade)
    _pDummy.updateMatrix()
    pool.mesh.setMatrixAt(i, _pDummy.matrix)
  }
  if (any || pool.dirty) pool.mesh.instanceMatrix.needsUpdate = true
  pool.dirty = any
}
function tickParticles(delta) {
  tickPool(dustPool, delta, -5.5, 2.2)
  tickPool(confettiPool, delta, -13, 0.6)
}
// ─── Camera Shake ─────────────────────────────────────────────────────────────
function addShake(a) {
  shakeAmp = Math.min(shakeAmp + a, 0.4)
}
function tickShake(delta, time) {
  if (shakeAmp < 0.0005) { shakeAmp = 0; return }
  updateCamera()
  const t = time * 0.001
  camera.position.y += Math.sin(t * 91) * shakeAmp
  camera.position.x += Math.sin(t * 83 + 1.7) * shakeAmp * 0.6
  shakeAmp *= Math.exp(-7 * delta)
}
// ─── Build Scene ──────────────────────────────────────────────────────────────
// Lathe profile with rounded edges + slight taper — reads far better than a raw cylinder
function buildDiskGeometry(r) {
  const h = DISK_HEIGHT
  const b = 0.09 // bevel radius
  const rt = r - 0.06 // top taper
  const pts = [new THREE.Vector2(0.01, -h / 2), new THREE.Vector2(r - b, -h / 2)]
  for (let i = 1; i <= 5; i++) {
    const a = (i / 5) * Math.PI * 0.5
    pts.push(new THREE.Vector2(r - b + Math.sin(a) * b, -h / 2 + b - Math.cos(a) * b))
  }
  for (let i = 0; i <= 5; i++) {
    const a = (i / 5) * Math.PI * 0.5
    pts.push(new THREE.Vector2(rt - b + Math.cos(a) * b, h / 2 - b + Math.sin(a) * b))
  }
  pts.push(new THREE.Vector2(0.01, h / 2))
  return new THREE.LatheGeometry(pts, 64)
}
function buildScene() {
  while (gameGroup.children.length > 0) gameGroup.remove(gameGroup.children[0])
  clickZones.length = 0
  ringMeshes.length = 0
  towerMaterials.length = 0
  for (const k in diskMeshes) delete diskMeshes[k]
  for (const k in diskFX) delete diskFX[k]
  // Vast landscape — flat play zone, prior rolling hills beyond
  const TERRAIN_SIZE = 520
  const TERRAIN_SEGS = 160
  const terrainGeo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGS, TERRAIN_SEGS)
  terrainGeo.rotateX(-Math.PI / 2)
  const tPos = terrainGeo.attributes.position
  const terrainHalf = TERRAIN_SIZE * 0.5
  for (let i = 0; i < tPos.count; i++) {
    const x = tPos.getX(i)
    const z = tPos.getZ(i)
    const dist = Math.sqrt(x * x + z * z)
    // Elliptical flat zone under the towers
    const flatDist = Math.max(0, Math.sqrt((x / 12) ** 2 + (z / 5) ** 2) - 1)
    const blend = Math.min(flatDist * flatDist * 0.55, 1)
    const hills = (
      Math.sin(x * 0.09 + 1.1) * Math.cos(z * 0.13 + 0.8) * 2.4 +
      Math.sin(x * 0.21 - 0.5) * Math.cos(z * 0.27 + 1.5) * 1.1 +
      Math.sin(x * 0.44 + 2.0) * Math.cos(z * 0.39 - 0.3) * 0.45
    ) * blend
    const edgeFade = 1 - Math.pow(Math.min(dist / (terrainHalf * 0.88), 1), 1.6)
    const h = hills * edgeFade
    tPos.setY(i, h)
  }
  terrainGeo.computeVertexNormals()
  terrainMesh = new THREE.Mesh(
    terrainGeo,
    new THREE.MeshStandardMaterial({ color: 0x4a4f58, roughness: 0.96, metalness: 0.03 }),
  )
  terrainMesh.receiveShadow = true
  gameGroup.add(terrainMesh)
  const ringR = getDiskRadius(NUM_DISKS) + 0.4
  for (let i = 0; i < 3; i++) {
    // Tower rod + rounded cap
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.85, metalness: 0.05 })
    towerMaterials.push(towerMat)
    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(TOWER_RADIUS * 0.8, TOWER_RADIUS, TOWER_HEIGHT, 16),
      towerMat,
    )
    tower.position.set(TOWER_X[i], TOWER_HEIGHT / 2, 0)
    tower.castShadow = true
    gameGroup.add(tower)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(TOWER_RADIUS * 0.8, 12, 8), towerMat)
    cap.position.set(TOWER_X[i], TOWER_HEIGHT, 0)
    cap.castShadow = true
    gameGroup.add(cap)
    // Landing pad under each tower — grounds the tower visually
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(ringR + 0.3, ringR + 0.45, 0.16, 48),
      towerMat,
    )
    pad.position.set(TOWER_X[i], -0.02, 0)
    pad.receiveShadow = true
    gameGroup.add(pad)
    // Wide invisible cylinder — easy click/drag target
    const cz = new THREE.Mesh(
      new THREE.CylinderGeometry(DISK_MAX_R + 0.5, DISK_MAX_R + 0.5, TOWER_HEIGHT + 1, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    cz.position.set(TOWER_X[i], TOWER_HEIGHT / 2 - 0.5, 0)
    cz.userData = { towerIndex: i }
    gameGroup.add(cz)
    clickZones.push(cz)
    // Ring indicator
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(ringR, 0.07, 8, 48),
      new THREE.MeshStandardMaterial({
        color: 0xffeb3b,
        emissive: new THREE.Color(0xffeb3b),
        emissiveIntensity: 0,
        transparent: true,
        opacity: 0,
      }),
    )
    ring.rotation.x = Math.PI / 2
    ring.position.set(TOWER_X[i], 0.13, 0)
    ring.userData = { targetOpacity: 0, targetIntensity: 0, pulse: false }
    gameGroup.add(ring)
    ringMeshes.push(ring)
  }
  // Disks — beveled lathe profile, clearcoat finish
  for (let size = 1; size <= NUM_DISKS; size++) {
    const r = getDiskRadius(size)
    const disk = new THREE.Mesh(
      buildDiskGeometry(r),
      new THREE.MeshPhysicalMaterial({
        color: DISK_COLORS[(size - 1) % DISK_COLORS.length],
        roughness: 0.34,
        metalness: 0.12,
        clearcoat: 0.7,
        clearcoatRoughness: 0.3,
      }),
    )
    disk.castShadow = true
    disk.receiveShadow = true
    disk.userData = { diskSize: size }
    gameGroup.add(disk)
    diskMeshes[size] = disk
    diskFX[size] = { squash: 1, squashV: 0, vx: 0, tilt: 0, lastX: null }
  }
}
// ─── Ring Helpers ─────────────────────────────────────────────────────────────
function clearRings() {
  for (const r of ringMeshes) {
    r.userData.targetOpacity = 0
    r.userData.targetIntensity = 0
    r.userData.pulse = false
  }
}
function setRing(towerIdx, colorHex, opacity = 0.85) {
  const r = ringMeshes[towerIdx]
  r.material.color.set(colorHex)
  r.material.emissive.set(colorHex)
  r.userData.targetOpacity = opacity
  r.userData.targetIntensity = 1.4
  r.userData.pulse = colorHex === 0x00e676
}
function tickRings(delta, time) {
  const k = Math.min(delta * 14, 1)
  for (const r of ringMeshes) {
    r.material.opacity += (r.userData.targetOpacity - r.material.opacity) * k
    r.material.emissiveIntensity += (r.userData.targetIntensity - r.material.emissiveIntensity) * k
    const pulsing = r.userData.pulse && r.material.opacity > 0.05
    const s = pulsing ? 1 + Math.sin(time * 0.007) * 0.04 : 1
    r.scale.set(s, s, 1)
  }
}
// Show ring for the tower the disk is snapped to
function updateDragRings(nearTower) {
  clearRings()
  const { diskSize, fromTower } = dragInfo
  const toStack = stacks[nearTower]
  if (nearTower === fromTower) {
    setRing(nearTower, 0xffeb3b, 0.5)
  } else if (!toStack.length || toStack[toStack.length - 1] > diskSize) {
    setRing(nearTower, 0x00e676) // green = valid
  } else {
    setRing(nearTower, 0xff3333) // red = blocked
  }
}
// ─── Disk FX ── squash & stretch + velocity tilt, shared by every animation ──
function applySquashImpulse(size, impulse) {
  const fx = diskFX[size]
  if (fx) fx.squashV -= impulse
}
function tickDiskFX(delta) {
  for (let size = 1; size <= NUM_DISKS; size++) {
    const mesh = diskMeshes[size]
    const fx = diskFX[size]
    if (!mesh || !fx) continue
    // Tilt follows horizontal velocity — disks bank into their motion
    const vel = fx.lastX == null ? 0 : (mesh.position.x - fx.lastX) / Math.max(delta, 1e-4)
    fx.lastX = mesh.position.x
    const tiltTarget = THREE.MathUtils.clamp(-vel * 0.012, -0.25, 0.25)
    fx.tilt += (tiltTarget - fx.tilt) * Math.min(delta * 14, 1)
    mesh.rotation.z = fx.tilt
    // Spring squash back toward rest
    const accel = (1 - fx.squash) * SQUASH_STIFFNESS - fx.squashV * SQUASH_DAMPING
    fx.squashV += accel * delta
    fx.squash = THREE.MathUtils.clamp(fx.squash + fx.squashV * delta, 0.45, 1.5)
    const s = fx.squash
    mesh.scale.set(1 + (1 - s) * 0.55, s, 1 + (1 - s) * 0.55)
  }
}
function isDiskAnimating(size) {
  if (dragInfo && dragInfo.diskSize === size) return true
  if (dropAnim && dropAnim.diskSize === size) return true
  for (const a of introAnims) if (a.size === size) return true
  return false
}
// Resting disks: snap to stack slot, keeping the squashed bottom planted
function tickRestingDisks() {
  for (let p = 0; p < 3; p++) {
    for (let s = 0; s < stacks[p].length; s++) {
      const size = stacks[p][s]
      if (isDiskAnimating(size)) continue
      const mesh = diskMeshes[size]
      const fx = diskFX[size]
      if (!mesh || !fx) continue
      mesh.position.x = TOWER_X[p]
      mesh.position.z = 0
      mesh.position.y = getDiskY(s) - (1 - Math.min(fx.squash, 1)) * DISK_HEIGHT * 0.5
    }
  }
}
function tickFxQueue() {
  for (let i = fxQueue.length - 1; i >= 0; i--) {
    if (clockTime >= fxQueue[i].at) {
      applySquashImpulse(fxQueue[i].size, fxQueue[i].impulse)
      fxQueue.splice(i, 1)
    }
  }
}
// Impact: squash the landing disk, puff dust at its rim, thud, shake the camera,
// and send a compression wave down the stack underneath
function onDiskImpact(diskSize, tower, restY, impact, belowCount) {
  applySquashImpulse(diskSize, impact * 5.5)
  const r = getDiskRadius(diskSize)
  spawnDust(
    TOWER_X[tower],
    Math.max(restY - DISK_HEIGHT / 2, BASE_TOP_Y) + 0.04,
    0,
    r,
    Math.round(6 + impact * 10),
    0.6 + impact,
  )
  addShake(impact * 0.05 + (diskSize / NUM_DISKS) * impact * 0.06)
  sfx.drop(Math.min(impact + 0.2, 1))
  for (let d = 0; d < belowCount; d++) {
    const size = stacks[tower][belowCount - 1 - d]
    if (size == null) break
    fxQueue.push({ at: clockTime + 0.03 + d * 0.035, size, impulse: impact * 2.2 * Math.pow(0.7, d) })
  }
}
// ─── Lift Animation ───────────────────────────────────────────────────────────
function tickLift(delta) {
  liftAnim.t += delta / LIFT_DUR
  const p = easeOutBack(Math.min(liftAnim.t, 1), 1.4)
  diskMeshes[dragInfo.diskSize].position.y = liftAnim.startY + (LIFT_Y - liftAnim.startY) * p
  if (liftAnim.t >= 1) {
    diskMeshes[dragInfo.diskSize].position.y = LIFT_Y
    liftAnim = null
    isDragging = true
  }
}
// ─── Drag Spring ── disk chases the snapped tower with a damped spring + bob ───
function tickDragSpring(delta) {
  if (!dragInfo || !isDragging || animating) return
  const mesh = diskMeshes[dragInfo.diskSize]
  const fx = diskFX[dragInfo.diskSize]
  const c = 2 * Math.sqrt(DRAG_SPRING_K) * DRAG_SPRING_DAMPING
  fx.vx += ((dragInfo.targetX - mesh.position.x) * DRAG_SPRING_K - fx.vx * c) * delta
  mesh.position.x += fx.vx * delta
  dragInfo.bobT += delta
  mesh.position.y = LIFT_Y + Math.sin(dragInfo.bobT * 3.1) * 0.07
}
// ─── Drop / Repel Animation ───────────────────────────────────────────────────
function finishDrop(a) {
  diskMeshes[a.diskSize].position.y = a.targetY
  if (a.type === 'valid') {
    stacks[a.fromTower].pop()
    stacks[a.toTower].push(a.diskSize)
    moves++
    updateUI()
    checkWin()
  }
  dropAnim = null
  dragInfo = null
  animating = false
}
function tickDrop(delta) {
  const a = dropAnim
  const mesh = diskMeshes[a.diskSize]
  if (a.phase === 'across') {
    a.t += delta
    const dur = a.type === 'valid' ? DROP_DUR.across : DROP_DUR.repelAcross
    const ease = a.type === 'repel' ? easeOutBack : easeInOut
    const p = ease(Math.min(a.t / dur, 1))
    mesh.position.x = a.startX + (a.targetX - a.startX) * p
    if (a.t >= dur) {
      mesh.position.x = a.targetX
      a.phase = 'fall'
      a.vy = 0
    }
  } else {
    // Gravity fall with a single small bounce
    a.vy += GRAVITY * delta
    mesh.position.y += a.vy * delta
    if (mesh.position.y > a.targetY) return
    mesh.position.y = a.targetY
    const impact = THREE.MathUtils.clamp(-a.vy / 42, 0, 1)
    if (!a.bounced && impact > 0.2) {
      a.bounced = true
      a.vy = -a.vy * BOUNCE_RESTITUTION
      onDiskImpact(a.diskSize, a.tower, a.targetY, impact, a.belowCount)
    } else {
      finishDrop(a)
    }
  }
}
// ─── Intro ── disks rain onto the first tower, bottom-up, with bounce + dust ───
function startIntro() {
  introAnims = []
  for (let s = 0; s < stacks[0].length; s++) {
    const size = stacks[0][s]
    const targetY = getDiskY(s)
    diskMeshes[size].position.set(TOWER_X[0], targetY + 7 + s * 2.6, 0)
    introAnims.push({ size, tower: 0, targetY, vy: 0, bounced: false, belowCount: s })
  }
  animating = introAnims.length > 0
}
function tickIntro(delta) {
  for (let i = introAnims.length - 1; i >= 0; i--) {
    const a = introAnims[i]
    const mesh = diskMeshes[a.size]
    a.vy += GRAVITY * delta
    mesh.position.y += a.vy * delta
    if (mesh.position.y > a.targetY) continue
    mesh.position.y = a.targetY
    const impact = THREE.MathUtils.clamp(-a.vy / 46, 0, 1)
    if (!a.bounced && impact > 0.2) {
      a.bounced = true
      a.vy = -a.vy * BOUNCE_RESTITUTION
      onDiskImpact(a.size, a.tower, a.targetY, impact * 0.8, a.belowCount)
    } else {
      introAnims.splice(i, 1)
      if (!introAnims.length && !dropAnim) animating = false
    }
  }
}
// ─── Raycasting ───────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()
function setMouse(e) {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
}
// ─── Camera Controls ──────────────────────────────────────────────────────────
function getCameraYawPitch() {
  const { x, y, z } = cameraOffset
  const horiz = Math.sqrt(x * x + z * z)
  return {
    yaw: Math.atan2(x, z),
    pitch: Math.atan2(y, horiz),
    distance: Math.sqrt(x * x + y * y + z * z),
  }
}
function setCameraYawPitch(yaw, pitch, distance) {
  const clampedPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, pitch))
  const cosPitch = Math.cos(clampedPitch)
  cameraOffset.set(
    Math.sin(yaw) * distance * cosPitch,
    Math.sin(clampedPitch) * distance,
    Math.cos(yaw) * distance * cosPitch,
  )
  updateCamera()
}
function getCameraPlanarAxes() {
  camera.getWorldDirection(_camForward)
  _camForward.y = 0
  if (_camForward.lengthSq() < 1e-6) _camForward.set(0, 0, -1)
  else _camForward.normalize()
  _camRight.crossVectors(_camForward, camera.up).normalize()
  _camUp.copy(camera.up).normalize()
}
function panCamera(dx, dy, scale = 1) {
  const { distance } = getCameraYawPitch()
  getCameraPlanarAxes()
  const amount = distance * PAN_SENS * scale
  cameraTarget.addScaledVector(_camRight, -dx * amount)
  cameraTarget.addScaledVector(_camUp, dy * amount)
  updateCamera()
}
function zoomCamera(deltaY) {
  const { yaw, pitch, distance } = getCameraYawPitch()
  const newDistance = Math.max(
    CAMERA_DIST_MIN,
    Math.min(CAMERA_DIST_MAX, distance * Math.exp(deltaY * ZOOM_SENS)),
  )
  setCameraYawPitch(yaw, pitch, newDistance)
}
function tickCameraKeyboard(delta) {
  if (dragInfo || animating) return
  const speed = CAMERA_MOVE_SPEED * delta
  let moved = false
  getCameraPlanarAxes()
  if (keys.a) { cameraTarget.addScaledVector(_camRight, -speed); moved = true }
  if (keys.d) { cameraTarget.addScaledVector(_camRight, speed); moved = true }
  if (keys.w) { cameraTarget.addScaledVector(_camForward, speed); moved = true }
  if (keys.s) { cameraTarget.addScaledVector(_camForward, -speed); moved = true }
  if (moved) updateCamera()
}
function startCameraOrbit(e) {
  isOrbiting = true
  orbitLast.x = e.clientX
  orbitLast.y = e.clientY
  document.body.style.cursor = 'grabbing'
}
function startCameraPan(e) {
  isPanning = true
  orbitLast.x = e.clientX
  orbitLast.y = e.clientY
  document.body.style.cursor = 'move'
}
function tryStartDiskDrag(e) {
  if (animating || dragInfo || gameWon) return false
  // Screen-space tower selection — same parallax-free approach as mousemove snap
  let best = 0, bestDist = Infinity
  for (let i = 0; i < 3; i++) {
    _projVec.set(TOWER_X[i], TOWER_HEIGHT * 0.5, 0)
    const d = Math.abs(e.clientX - screenX(_projVec))
    if (d < bestDist) { bestDist = d; best = i }
  }
  // Gate on 3D click zone so clicks far outside the scene don't trigger
  setMouse(e)
  raycaster.setFromCamera(mouse, camera)
  if (!raycaster.intersectObjects(clickZones).length) return false
  if (!stacks[best].length) return false
  const diskSize = stacks[best][stacks[best].length - 1]
  dragInfo = { diskSize, fromTower: best, stackPos: stacks[best].length - 1, targetX: TOWER_X[best], bobT: 0 }
  liftAnim = { t: 0, startY: diskMeshes[diskSize].position.y }
  isDragging = false
  diskFX[diskSize].vx = 0
  applySquashImpulse(diskSize, -2.0) // stretch on pickup
  sfx.lift()
  document.body.style.cursor = 'grabbing'
  return true
}
// ─── Mouse Handlers ───────────────────────────────────────────────────────────
canvas.addEventListener('contextmenu', (e) => e.preventDefault())
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1 || e.button === 2) {
    e.preventDefault()
    if (!animating && !dragInfo) startCameraPan(e)
    return
  }
  if (e.button !== 0) return
  if (tryStartDiskDrag(e)) return
  if (!animating && !dragInfo) startCameraOrbit(e)
})
canvas.addEventListener('wheel', (e) => {
  e.preventDefault()
  if (animating || dragInfo) return
  zoomCamera(e.deltaY)
}, { passive: false })
canvas.addEventListener('mousemove', (e) => {
  if (isPanning) {
    const dx = e.clientX - orbitLast.x
    const dy = e.clientY - orbitLast.y
    orbitLast.x = e.clientX
    orbitLast.y = e.clientY
    panCamera(dx, dy)
    return
  }
  if (isOrbiting) {
    const dx = e.clientX - orbitLast.x
    const dy = e.clientY - orbitLast.y
    orbitLast.x = e.clientX
    orbitLast.y = e.clientY
    const { yaw, pitch, distance } = getCameraYawPitch()
    setCameraYawPitch(yaw - dx * ORBIT_SENS, pitch + dy * ORBIT_SENS, distance)
    return
  }
  if (!dragInfo) {
    setMouse(e)
    raycaster.setFromCamera(mouse, camera)
    const hits = raycaster.intersectObjects(clickZones)
    if (hits.length) {
      const p = getNearestTowerToClient(e.clientX)
      document.body.style.cursor = stacks[p].length > 0 ? 'grab' : 'default'
    } else {
      document.body.style.cursor = 'default'
    }
    return
  }
  // Drop/repel animation is running — let it own the disk position, don't override
  if (animating) return
  const nearTower = getNearestTowerToClient(e.clientX)
  const { diskSize, fromTower } = dragInfo
  const toStack = stacks[nearTower]
  const blocked = nearTower !== fromTower && toStack.length > 0 && toStack[toStack.length - 1] < diskSize
  // Blocked tower: spring stays at source, still show red ring so user knows why
  dragInfo.targetX = blocked ? TOWER_X[fromTower] : TOWER_X[nearTower]
  if (isDragging) updateDragRings(nearTower)
})
window.addEventListener('mouseup', (e) => {
  if (isPanning) {
    isPanning = false
    document.body.style.cursor = 'default'
  }
  if (isOrbiting) {
    isOrbiting = false
    document.body.style.cursor = 'default'
  }
  if (!dragInfo) return
  // If still lifting, snap disk to lift height immediately
  if (liftAnim) {
    diskMeshes[dragInfo.diskSize].position.y = LIFT_Y
    liftAnim = null
    isDragging = true
  }
  if (!isDragging) return
  isDragging = false
  animating = true
  clearRings()
  const mesh = diskMeshes[dragInfo.diskSize]
  const { diskSize, fromTower, stackPos, targetX } = dragInfo
  diskFX[diskSize].vx = 0
  // The snapped target X (not the springing mesh position) decides the tower
  let toTower = TOWER_X.findIndex(px => Math.abs(px - targetX) < 0.01)
  if (toTower === -1) toTower = fromTower
  const toStack = stacks[toTower]
  const isValid = toTower !== fromTower && (!toStack.length || toStack[toStack.length - 1] > diskSize)
  document.body.style.cursor = 'default'
  if (isValid) {
    dropAnim = {
      type: 'valid',
      diskSize, fromTower, toTower, tower: toTower,
      phase: 'across', t: 0, vy: 0, bounced: false,
      startX: mesh.position.x,
      targetX: TOWER_X[toTower],
      targetY: getDiskY(toStack.length),
      belowCount: toStack.length,
    }
  } else {
    // Flash invalid tower red briefly
    if (toTower !== fromTower) {
      setRing(toTower, 0xff3333, 0.9)
      setTimeout(clearRings, 320)
      sfx.invalid()
    }
    dropAnim = {
      type: toTower === fromTower ? 'return' : 'repel',
      diskSize, fromTower, tower: fromTower,
      phase: 'across', t: 0, vy: 0, bounced: false,
      startX: mesh.position.x,
      targetX: TOWER_X[fromTower],
      targetY: getDiskY(stackPos),
      belowCount: stackPos,
    }
  }
})
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return
  keys[e.key.toLowerCase()] = true
})
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false
})
window.addEventListener('blur', () => {
  for (const k in keys) delete keys[k]
})
// ─── UI ───────────────────────────────────────────────────────────────────────
const DISK_COLORS_HEX = [
  '#e74c3c', '#e67e22', '#f1c40f',
  '#2ecc71', '#3498db', '#9b59b6', '#1abc9c',
]
function updateDebugDisplay() {
  const ids = ['debug-a', 'debug-b', 'debug-c']
  for (let p = 0; p < 3; p++) {
    const el = document.getElementById(ids[p])
    el.innerHTML = ''
    const stack = stacks[p]
    for (let s = 0; s < stack.length; s++) {
      const size = stack[s]
      const div = document.createElement('div')
      div.className = 'debug-disk' + (s === stack.length - 1 ? ' top' : '')
      div.style.background = DISK_COLORS_HEX[(size - 1) % DISK_COLORS_HEX.length]
      div.textContent = size
      el.appendChild(div)
    }
    if (!stack.length) {
      const empty = document.createElement('div')
      empty.style.color = 'rgba(255,255,255,0.2)'
      empty.style.fontSize = '0.7rem'
      empty.textContent = '—'
      el.appendChild(empty)
    }
  }
}
// Highlight the top disk on each tower so it's clear what's grabbable
function updateTopDiskHighlight() {
  for (let size = 1; size <= NUM_DISKS; size++) {
    if (diskMeshes[size]) diskMeshes[size].material.emissiveIntensity = 0
  }
  if (dragInfo || animating) {
    if (dragInfo) {
      const m = diskMeshes[dragInfo.diskSize]
      m.material.emissive.copy(m.material.color)
      m.material.emissiveIntensity = 0.35
    }
    return
  }
  for (let p = 0; p < 3; p++) {
    if (stacks[p].length) {
      const topSize = stacks[p][stacks[p].length - 1]
      if (diskMeshes[topSize]) {
        diskMeshes[topSize].material.emissive.copy(diskMeshes[topSize].material.color)
        diskMeshes[topSize].material.emissiveIntensity = 0.25
      }
    }
  }
}
function updateUI() {
  const movesEl = document.getElementById('moves')
  if (movesEl.textContent !== String(moves)) {
    movesEl.textContent = moves
    if (moves > 0) {
      movesEl.classList.remove('bump')
      void movesEl.offsetWidth // restart the animation
      movesEl.classList.add('bump')
    }
  }
  document.getElementById('min-moves').textContent = (1 << NUM_DISKS) - 1
  updateDebugDisplay()
}
// ─── Win Celebration ──────────────────────────────────────────────────────────
function celebrate() {
  sfx.win()
  const topY = TOWER_HEIGHT + 1.2
  spawnConfetti(TOWER_X[2], topY, 0, 90)
  setTimeout(() => spawnConfetti(TOWER_X[0], topY * 0.8, 0, 50), 280)
  setTimeout(() => spawnConfetti(TOWER_X[1], topY * 0.9, 0, 50), 520)
  // Bounce wave up the solved tower
  for (let s = 0; s < stacks[2].length; s++) {
    fxQueue.push({ at: clockTime + 0.15 + s * 0.07, size: stacks[2][s], impulse: 3.2 })
  }
}
function checkWin() {
  if (stacks[2].length === NUM_DISKS) {
    gameWon = true
    celebrate()
    setTimeout(() => {
      document.getElementById('win-moves').textContent = moves
      document.getElementById('win-min').textContent = (1 << NUM_DISKS) - 1
      document.getElementById('win-overlay').style.display = 'flex'
    }, 1600)
  }
}
// ─── Init ─────────────────────────────────────────────────────────────────────
function initGame(n) {
  NUM_DISKS = n
  stacks = [Array.from({ length: n }, (_, i) => n - i), [], []]
  moves = 0
  gameWon = false
  dragInfo = null
  isDragging = false
  liftAnim = null
  dropAnim = null
  animating = false
  fxQueue.length = 0
  themeTransition = null // mid-fade restart: snap to the target theme
  buildScene()
  applyTheme(currentTheme) // recolor freshly built terrain + towers to active theme
  startIntro()
  updateUI()
  document.getElementById('win-overlay').style.display = 'none'
}
function tickDrone(time, delta) {
  if (!droneGroup.visible) return
  const t = time * 0.001
  const {
    bounds, minSeparation, maxSpeed, wanderStrength, separationStrength,
    edgeStrength, driftStrength, damping,
  } = DRONE_SWARM
  const minSepSq = minSeparation * minSeparation

  for (const drone of drones) {
    if (t >= drone.nextWanderAt) pickDroneWanderTarget(drone)

    let ax = (drone.wanderX - drone.x) * wanderStrength
    let az = (drone.wanderZ - drone.z) * wanderStrength
    let ay = (drone.wanderY - drone.y) * wanderStrength * 0.42

    ax += Math.sin(t * 0.62 + drone.driftPhase) * driftStrength
    az += Math.cos(t * 0.48 + drone.driftPhase * 1.35) * driftStrength
    ay += Math.sin(t * 0.81 + drone.driftPhase * 0.7) * driftStrength * 0.28

    const cx = (bounds.x[0] + bounds.x[1]) * 0.5
    const cz = (bounds.z[0] + bounds.z[1]) * 0.5
    const cy = (bounds.y[0] + bounds.y[1]) * 0.5
    const edgeX = Math.min(drone.x - bounds.x[0], bounds.x[1] - drone.x)
    const edgeZ = Math.min(drone.z - bounds.z[0], bounds.z[1] - drone.z)
    const edgeY = Math.min(drone.y - bounds.y[0], bounds.y[1] - drone.y)
    if (edgeX < 2.8) ax += (cx - drone.x) * edgeStrength * (1 - edgeX / 2.8)
    if (edgeZ < 2.4) az += (cz - drone.z) * edgeStrength * (1 - edgeZ / 2.4)
    if (edgeY < 1.6) ay += (cy - drone.y) * edgeStrength * (1 - edgeY / 1.6)

    for (const other of drones) {
      if (other === drone) continue
      _droneSep.set(drone.x - other.x, 0, drone.z - other.z)
      const distSq = _droneSep.lengthSq()
      if (distSq < minSepSq && distSq > 1e-6) {
        const dist = Math.sqrt(distSq)
        const push = (minSeparation - dist) / minSeparation
        ax += (_droneSep.x / dist) * separationStrength * push
        az += (_droneSep.z / dist) * separationStrength * push
        const yGap = Math.abs(drone.y - other.y)
        if (yGap < 1.1) ay += Math.sign(drone.y - other.y || 0.2) * separationStrength * 0.22 * push
      }
    }

    drone.vx = (drone.vx + ax * delta) * damping
    drone.vz = (drone.vz + az * delta) * damping
    drone.vy = (drone.vy + ay * delta) * damping

    const speed = Math.sqrt(drone.vx * drone.vx + drone.vz * drone.vz + drone.vy * drone.vy)
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed
      drone.vx *= scale
      drone.vz *= scale
      drone.vy *= scale
    }

    drone.x = THREE.MathUtils.clamp(drone.x + drone.vx * delta, bounds.x[0], bounds.x[1])
    drone.z = THREE.MathUtils.clamp(drone.z + drone.vz * delta, bounds.z[0], bounds.z[1])
    drone.y = THREE.MathUtils.clamp(drone.y + drone.vy * delta, bounds.y[0], bounds.y[1])

    drone.rig.position.set(drone.x, drone.y, drone.z)
    drone.spotTarget.updateMatrixWorld()
    const planarSpeed = Math.sqrt(drone.vx * drone.vx + drone.vz * drone.vz)
    if (planarSpeed > 0.05) {
      drone.rig.rotation.y = Math.atan2(drone.vx, drone.vz)
      drone.rig.rotation.z = THREE.MathUtils.clamp(-drone.vx * 0.05, -0.18, 0.18)
    }
    for (const child of drone.rig.children[0].children) {
      if (child.userData.propeller) child.rotation.y += delta * child.userData.spinDir * 28
    }
  }
}
// ─── Resize ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})
// ─── Render Loop ──────────────────────────────────────────────────────────────
let lastTime = 0
function animate(time) {
  const delta = Math.min((time - lastTime) / 1000, 0.05)
  lastTime = time
  clockTime = time * 0.001
  if (liftAnim) tickLift(delta)
  if (dropAnim) tickDrop(delta)
  if (introAnims.length) tickIntro(delta)
  tickDragSpring(delta)
  tickFxQueue()
  tickDiskFX(delta)
  tickRestingDisks()
  tickRings(delta, time)
  tickParticles(delta)
  tickCameraKeyboard(delta)
  tickDrone(time, delta)
  tickEarth(delta)
  tickThemeTransition(delta)
  // Slow victory-lap orbit while the win celebration plays
  if (gameWon && !isOrbiting && !isPanning) {
    const { yaw, pitch, distance } = getCameraYawPitch()
    setCameraYawPitch(yaw + delta * 0.12, pitch, distance)
  }
  tickShake(delta, time)
  updateTopDiskHighlight()
  if (renderPipeline) renderPipeline.render()
  else renderer.render(scene, camera)
}
// ─── Bootstrap ────────────────────────────────────────────────────────────────
document.getElementById('disk-count').addEventListener('change', () => {
  initGame(parseInt(document.getElementById('disk-count').value))
})

document.getElementById('restart-btn').addEventListener('click', () => {
  initGame(parseInt(document.getElementById('disk-count').value))
})

document.getElementById('play-again-btn').addEventListener('click', () => {
  initGame(parseInt(document.getElementById('disk-count').value))
})

document.getElementById('theme-toggle').addEventListener('click', () => {
  startThemeTransition(currentTheme === 'day' ? 'night' : 'day')
})

document.getElementById('sound-toggle').addEventListener('click', () => {
  audioMuted = !audioMuted
  if (!audioMuted) getAudioCtx()
  document.getElementById('sound-toggle').textContent = audioMuted ? '🔇' : '🔊'
})

async function start() {
  await renderer.init()
  currentTheme = pickThemeByTime()
  initGame(4)
  try {
    const volumetric = setupVolumetricLighting(renderer, scene, camera)
    renderPipeline = volumetric.renderPipeline
    setVolumetricEnabled = volumetric.setEnabled
    setVolumetricSmoke = volumetric.setSmoke
    applyTheme(currentTheme)
  } catch (err) {
    console.warn('Volumetric lighting disabled:', err)
    renderPipeline = null
    setVolumetricEnabled = null
    setVolumetricSmoke = null
    applyTheme(currentTheme)
  }
  renderer.setAnimationLoop(animate)
}
start().catch((err) => {
  console.error('Failed to start renderer:', err)
  document.getElementById('hint').textContent = 'Failed to start 3D renderer — check the browser console.'
  renderer.setAnimationLoop(animate)
})
