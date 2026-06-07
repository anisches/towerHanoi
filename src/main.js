import * as THREE from 'three/webgpu'
import { setupVolumetricLighting, enableLightForVolumetrics } from './volumetric.js'
// ─── Constants ────────────────────────────────────────────────────────────────
const PEG_SPACING = 5.5
const PEG_X = [-PEG_SPACING, 0, PEG_SPACING]
const PEG_HEIGHT = 5.5
const PEG_RADIUS = 0.13
const BASE_TOP_Y = 0
const DISK_HEIGHT = 0.42
const DISK_GAP = 0.06
const DISK_MIN_R = 0.7
const DISK_MAX_R = 2.2
const LIFT_Y = PEG_HEIGHT + 2.0
const LIFT_DUR = 0.16
const DROP_DUR = { across: 0.18, down: 0.2, repelAcross: 0.38, repelDown: 0.2 }
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
    peg: 0x6d727a,
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
    peg: 0x57534e, // tailwind stone-600
    exposure: 1.05,
    icon: '🌙', // shown on toggle to switch TO night
  },
}
let currentTheme = 'night'
function pickThemeByTime() {
  const h = new Date().getHours()
  return h >= 6 && h < 18 ? 'day' : 'night'
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
const moonMesh = new THREE.Mesh(
  new THREE.SphereGeometry(2.4, 20, 20),
  new THREE.MeshBasicMaterial({ color: 0xe8f0ff, fog: false }),
)
nightSkyGroup.add(moonMesh)
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
const pegMaterials = [] // collected during buildScene so applyTheme can recolor them
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
  if (setVolumetricEnabled) {
    setVolumetricEnabled(isNight, t.volumetric?.intensity ?? 1.0)
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
  for (const m of pegMaterials) m.color.setHex(t.peg)
  document.body.classList.toggle('light', name === 'day')
  const tog = document.getElementById('theme-toggle')
  if (tog) tog.textContent = t.icon
}
// ─── Game State ───────────────────────────────────────────────────────────────
let NUM_DISKS = 4
let stacks = [[], [], []]
let moves = 0
let gameWon = false
// Drag state — lives only while user has mouse button held
let dragInfo = null // { diskSize, fromPeg, stackPos }
let isDragging = false // disk actively follows mouse (after lift completes)
let liftAnim = null // { t, startY }
// Post-release animation
let dropAnim = null // { type:'valid'|'repel'|'return', phase, t, ... }
let animating = false // drop/repel running — block new interactions
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
// Project disk center and each peg center to screen space, pick closest peg.
// Avoids the parallax error from comparing world X at LIFT_Y vs world X at ground.
const _projVec = new THREE.Vector3()
function screenX(worldPos) {
  _projVec.copy(worldPos)
  _projVec.project(camera)
  return (_projVec.x + 1) * 0.5 * window.innerWidth
}
// Compare mouse screen X against each peg's projected screen X — no world-space parallax.
function getNearestPegToClient(clientX) {
  let best = 0, bestDist = Infinity
  for (let i = 0; i < 3; i++) {
    _projVec.set(PEG_X[i], PEG_HEIGHT * 0.5, 0)
    const d = Math.abs(clientX - screenX(_projVec))
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}
// ─── Build Scene ──────────────────────────────────────────────────────────────
function buildScene() {
  while (gameGroup.children.length > 0) gameGroup.remove(gameGroup.children[0])
  clickZones.length = 0
  ringMeshes.length = 0
  pegMaterials.length = 0
  for (const k in diskMeshes) delete diskMeshes[k]
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
    // Elliptical flat zone under the pegs
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
    // Peg rod
    const pegMat = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, roughness: 0.85, metalness: 0.05 })
    pegMaterials.push(pegMat)
    const peg = new THREE.Mesh(
      new THREE.CylinderGeometry(PEG_RADIUS * 0.8, PEG_RADIUS, PEG_HEIGHT, 16),
      pegMat,
    )
    peg.position.set(PEG_X[i], PEG_HEIGHT / 2, 0)
    peg.castShadow = true
    gameGroup.add(peg)
    // Wide invisible cylinder — easy click/drag target
    const cz = new THREE.Mesh(
      new THREE.CylinderGeometry(DISK_MAX_R + 0.5, DISK_MAX_R + 0.5, PEG_HEIGHT + 1, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    cz.position.set(PEG_X[i], PEG_HEIGHT / 2 - 0.5, 0)
    cz.userData = { pegIndex: i }
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
    ring.position.set(PEG_X[i], 0.04, 0)
    gameGroup.add(ring)
    ringMeshes.push(ring)
  }
  // Disks
  for (let size = 1; size <= NUM_DISKS; size++) {
    const r = getDiskRadius(size)
    const disk = new THREE.Mesh(
      new THREE.CylinderGeometry(r - 0.08, r, DISK_HEIGHT, 48),
      new THREE.MeshStandardMaterial({
        color: DISK_COLORS[(size - 1) % DISK_COLORS.length],
        roughness: 0.3,
        metalness: 0.15,
      }),
    )
    disk.castShadow = true
    disk.receiveShadow = true
    disk.userData = { diskSize: size }
    gameGroup.add(disk)
    diskMeshes[size] = disk
  }
}
function positionAllDisks() {
  for (let p = 0; p < 3; p++) {
    for (let s = 0; s < stacks[p].length; s++) {
      diskMeshes[stacks[p][s]].position.set(PEG_X[p], getDiskY(s), 0)
    }
  }
}
// ─── Ring Helpers ─────────────────────────────────────────────────────────────
function clearRings() {
  for (const r of ringMeshes) {
    r.material.opacity = 0
    r.material.emissiveIntensity = 0
    r.material.color.set(0xffeb3b)
    r.material.emissive.set(0xffeb3b)
  }
}
function setRing(pegIdx, colorHex, opacity = 0.85) {
  const r = ringMeshes[pegIdx]
  r.material.color.set(colorHex)
  r.material.emissive.set(colorHex)
  r.material.opacity = opacity
  r.material.emissiveIntensity = 1.4
}
// Show ring for the peg the disk is snapped to
function updateDragRings(nearPeg) {
  clearRings()
  const { diskSize, fromPeg } = dragInfo
  const toStack = stacks[nearPeg]
  if (nearPeg === fromPeg) {
    setRing(nearPeg, 0xffeb3b, 0.5)
  } else if (!toStack.length || toStack[toStack.length - 1] > diskSize) {
    setRing(nearPeg, 0x00e676) // green = valid
  } else {
    setRing(nearPeg, 0xff3333) // red = blocked
  }
}
// ─── Lift Animation ───────────────────────────────────────────────────────────
function tickLift(delta) {
  liftAnim.t += delta / LIFT_DUR
  const p = easeInOut(Math.min(liftAnim.t, 1))
  diskMeshes[dragInfo.diskSize].position.y = liftAnim.startY + (LIFT_Y - liftAnim.startY) * p
  if (liftAnim.t >= 1) {
    diskMeshes[dragInfo.diskSize].position.y = LIFT_Y
    liftAnim = null
    isDragging = true
  }
}
// ─── Drop / Repel Animation ───────────────────────────────────────────────────
function tickDrop(delta) {
  const a = dropAnim
  const mesh = diskMeshes[a.diskSize]
  a.t += delta
  if (a.phase === 'across') {
    const dur = a.type === 'valid' ? DROP_DUR.across : DROP_DUR.repelAcross
    const ease = a.type === 'repel' ? easeOutBack : easeInOut
    const p = ease(Math.min(a.t / dur, 1))
    mesh.position.x = a.startX + (a.targetX - a.startX) * p
    if (a.t >= dur) {
      mesh.position.x = a.targetX
      a.t = 0
      a.phase = 'down'
    }
  } else if (a.phase === 'down') {
    const dur = a.type === 'valid' ? DROP_DUR.down : DROP_DUR.repelDown
    const p = easeInOut(Math.min(a.t / dur, 1))
    mesh.position.y = LIFT_Y + (a.targetY - LIFT_Y) * p
    if (a.t >= dur) {
      mesh.position.y = a.targetY
      if (a.type === 'valid') {
        stacks[a.fromPeg].pop()
        stacks[a.toPeg].push(a.diskSize)
        moves++
        updateUI()
        checkWin()
      }
      dropAnim = null
      dragInfo = null
      animating = false
    }
  }
}
// ─── Raycasting ───────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -LIFT_Y)
const dragHit = new THREE.Vector3()
function setMouse(e) {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1
}
function getPegAt(e) {
  setMouse(e)
  raycaster.setFromCamera(mouse, camera)
  const hits = raycaster.intersectObjects(clickZones)
  return hits.length ? hits[0].object.userData.pegIndex : -1
}
function getDragX(e) {
  setMouse(e)
  raycaster.setFromCamera(mouse, camera)
  if (raycaster.ray.intersectPlane(dragPlane, dragHit)) {
    return Math.max(PEG_X[0] - 3, Math.min(PEG_X[2] + 3, dragHit.x))
  }
  return null
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
  // Screen-space peg selection — same parallax-free approach as mousemove snap
  let best = 0, bestDist = Infinity
  for (let i = 0; i < 3; i++) {
    _projVec.set(PEG_X[i], PEG_HEIGHT * 0.5, 0)
    const d = Math.abs(e.clientX - screenX(_projVec))
    if (d < bestDist) { bestDist = d; best = i }
  }
  // Gate on 3D click zone so clicks far outside the scene don't trigger
  setMouse(e)
  raycaster.setFromCamera(mouse, camera)
  if (!raycaster.intersectObjects(clickZones).length) return false
  if (!stacks[best].length) return false
  const diskSize = stacks[best][stacks[best].length - 1]
  dragInfo = { diskSize, fromPeg: best, stackPos: stacks[best].length - 1 }
  liftAnim = { t: 0, startY: diskMeshes[diskSize].position.y }
  isDragging = false
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
      const p = getNearestPegToClient(e.clientX)
      document.body.style.cursor = stacks[p].length > 0 ? 'grab' : 'default'
    } else {
      document.body.style.cursor = 'default'
    }
    return
  }
  // Drop/repel animation is running — let it own the disk position, don't override
  if (animating) return
  const nearPeg = getNearestPegToClient(e.clientX)
  const { diskSize, fromPeg } = dragInfo
  const toStack = stacks[nearPeg]
  const blocked = nearPeg !== fromPeg && toStack.length > 0 && toStack[toStack.length - 1] < diskSize
  // Blocked peg: keep disk at source, still show red ring so user knows why
  diskMeshes[diskSize].position.x = blocked ? PEG_X[fromPeg] : PEG_X[nearPeg]
  if (isDragging) updateDragRings(nearPeg)
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
  const diskX = mesh.position.x
  const { diskSize, fromPeg, stackPos } = dragInfo
  // Use disk's world X (already enforced to a valid snap) rather than raw mouse position.
  // Fall back to fromPeg if x somehow drifted off a snap position.
  let toPeg = PEG_X.findIndex(px => Math.abs(px - diskX) < 0.01)
  if (toPeg === -1) toPeg = fromPeg
  const toStack = stacks[toPeg]
  const isValid = toPeg !== fromPeg && (!toStack.length || toStack[toStack.length - 1] > diskSize)
  document.body.style.cursor = 'default'
  if (isValid) {
    dropAnim = {
      type: 'valid',
      diskSize, fromPeg, toPeg,
      phase: 'across', t: 0,
      startX: diskX,
      targetX: PEG_X[toPeg],
      targetY: getDiskY(toStack.length),
    }
  } else {
    // Flash invalid peg red briefly
    if (toPeg !== fromPeg) {
      setRing(toPeg, 0xff3333, 0.9)
      setTimeout(clearRings, 320)
    }
    dropAnim = {
      type: toPeg === fromPeg ? 'return' : 'repel',
      diskSize, fromPeg,
      phase: 'across', t: 0,
      startX: diskX,
      targetX: PEG_X[fromPeg],
      targetY: getDiskY(stackPos),
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
// Highlight the top disk on each peg so it's clear what's grabbable
function updateTopDiskHighlight() {
  for (let size = 1; size <= NUM_DISKS; size++) {
    if (diskMeshes[size]) diskMeshes[size].material.emissiveIntensity = 0
  }
  if (dragInfo || animating) return
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
  document.getElementById('moves').textContent = moves
  document.getElementById('min-moves').textContent = (1 << NUM_DISKS) - 1
  updateDebugDisplay()
}
function checkWin() {
  if (stacks[2].length === NUM_DISKS) {
    gameWon = true
    setTimeout(() => {
      document.getElementById('win-moves').textContent = moves
      document.getElementById('win-min').textContent = (1 << NUM_DISKS) - 1
      document.getElementById('win-overlay').style.display = 'flex'
    }, 450)
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
  buildScene()
  applyTheme(currentTheme) // recolor freshly built terrain + pegs to active theme
  positionAllDisks()
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
  if (liftAnim) tickLift(delta)
  if (dropAnim) tickDrop(delta)
  tickCameraKeyboard(delta)
  tickDrone(time, delta)
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
  applyTheme(currentTheme === 'day' ? 'night' : 'day')
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