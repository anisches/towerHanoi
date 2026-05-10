import * as THREE from 'three'

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

// ─── Renderer / Scene / Camera ────────────────────────────────────────────────

const canvas = document.getElementById('canvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1a1a2e)
scene.fog = new THREE.FogExp2(0x1a1a2e, 0.016)

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(0, 9, 16)
camera.lookAt(0, 2, 0)

// ─── Lighting ─────────────────────────────────────────────────────────────────

scene.add(new THREE.AmbientLight(0x6688cc, 0.5))

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

const fillLight = new THREE.DirectionalLight(0x4466aa, 0.4)
fillLight.position.set(-5, 5, -5)
scene.add(fillLight)

// ─── Game State ───────────────────────────────────────────────────────────────

let NUM_DISKS = 4
let stacks = [[], [], []]
let moves = 0
let gameWon = false

// Drag state — lives only while user has mouse button held
let dragInfo = null     // { diskSize, fromPeg, stackPos }
let isDragging = false  // disk actively follows mouse (after lift completes)
let liftAnim = null     // { t, startY }

// Post-release animation
let dropAnim = null     // { type:'valid'|'repel'|'return', phase, t, ... }
let animating = false   // drop/repel running — block new interactions

// ─── Scene Objects ────────────────────────────────────────────────────────────

const gameGroup = new THREE.Group()
scene.add(gameGroup)

const diskMeshes = {}  // size -> Mesh
const clickZones = []  // [0,1,2] invisible hit cylinders
const ringMeshes = []  // [0,1,2] selection/feedback rings

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

function getNearestPegToDisk(diskSize) {
  const diskSX = screenX(diskMeshes[diskSize].position)
  let best = 0, bestDist = Infinity
  for (let i = 0; i < 3; i++) {
    _projVec.set(PEG_X[i], PEG_HEIGHT * 0.5, 0)  // peg mid-height as reference
    const pegSX = screenX(_projVec)
    const d = Math.abs(diskSX - pegSX)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

// ─── Build Scene ──────────────────────────────────────────────────────────────

function buildScene() {
  while (gameGroup.children.length > 0) gameGroup.remove(gameGroup.children[0])
  clickZones.length = 0
  ringMeshes.length = 0
  for (const k in diskMeshes) delete diskMeshes[k]

  // Base platform
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(20, 0.6, 5),
    new THREE.MeshStandardMaterial({ color: 0x5d3a1a, roughness: 0.85, metalness: 0.05 })
  )
  base.position.y = -0.3
  base.receiveShadow = true
  gameGroup.add(base)

  // Gold trim edge
  const trim = new THREE.Mesh(
    new THREE.BoxGeometry(20.5, 0.1, 5.5),
    new THREE.MeshStandardMaterial({ color: 0x8b6914, roughness: 0.45, metalness: 0.5 })
  )
  trim.position.y = -0.57
  gameGroup.add(trim)

  // Floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x16213e, roughness: 1.0 })
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.65
  floor.receiveShadow = true
  gameGroup.add(floor)

  const ringR = getDiskRadius(NUM_DISKS) + 0.4

  for (let i = 0; i < 3; i++) {
    // Peg rod
    const peg = new THREE.Mesh(
      new THREE.CylinderGeometry(PEG_RADIUS * 0.8, PEG_RADIUS, PEG_HEIGHT, 16),
      new THREE.MeshStandardMaterial({ color: 0xb08040, roughness: 0.4, metalness: 0.45 })
    )
    peg.position.set(PEG_X[i], PEG_HEIGHT / 2, 0)
    peg.castShadow = true
    gameGroup.add(peg)

    // Wide invisible cylinder — easy click/drag target
    const cz = new THREE.Mesh(
      new THREE.CylinderGeometry(DISK_MAX_R + 0.5, DISK_MAX_R + 0.5, PEG_HEIGHT + 1, 8),
      new THREE.MeshBasicMaterial({ visible: false })
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
      })
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
      })
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

// Color the ring of the peg the disk is hovering over
function updateDragRings() {
  clearRings()
  const { diskSize, fromPeg } = dragInfo
  const nearPeg = getNearestPegToDisk(diskSize)
  const toStack = stacks[nearPeg]

  if (nearPeg === fromPeg) {
    setRing(nearPeg, 0xffeb3b, 0.5)
  } else if (!toStack.length || toStack[toStack.length - 1] > diskSize) {
    setRing(nearPeg, 0x00e676)   // green = valid
  } else {
    setRing(nearPeg, 0xff3333)   // red = blocked
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

// ─── Mouse Handlers ───────────────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (animating || dragInfo || gameWon) return

  const pegIdx = getPegAt(e)
  if (pegIdx === -1 || !stacks[pegIdx].length) return

  const diskSize = stacks[pegIdx][stacks[pegIdx].length - 1]
  dragInfo = { diskSize, fromPeg: pegIdx, stackPos: stacks[pegIdx].length - 1 }
  liftAnim = { t: 0, startY: diskMeshes[diskSize].position.y }
  isDragging = false

  document.body.style.cursor = 'grabbing'
})

canvas.addEventListener('mousemove', (e) => {
  if (!dragInfo) {
    const p = getPegAt(e)
    document.body.style.cursor = (p !== -1 && stacks[p].length > 0) ? 'grab' : 'default'
    return
  }

  const x = getDragX(e)
  if (x === null) return

  // X follows mouse immediately (even during lift)
  diskMeshes[dragInfo.diskSize].position.x = x

  if (isDragging) updateDragRings()
})

window.addEventListener('mouseup', (e) => {
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
  const toPeg = getNearestPegToDisk(dragInfo.diskSize)
  const { diskSize, fromPeg, stackPos } = dragInfo
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

// ─── UI ───────────────────────────────────────────────────────────────────────

function updateUI() {
  document.getElementById('moves').textContent = moves
  document.getElementById('min-moves').textContent = (1 << NUM_DISKS) - 1
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
  positionAllDisks()
  updateUI()
  document.getElementById('win-overlay').style.display = 'none'
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
  requestAnimationFrame(animate)
  const delta = Math.min((time - lastTime) / 1000, 0.05)
  lastTime = time

  if (liftAnim) tickLift(delta)
  if (dropAnim) tickDrop(delta)

  renderer.render(scene, camera)
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.getElementById('restart-btn').addEventListener('click', () => {
  initGame(parseInt(document.getElementById('disk-count').value))
})
document.getElementById('play-again-btn').addEventListener('click', () => {
  initGame(parseInt(document.getElementById('disk-count').value))
})

initGame(4)
requestAnimationFrame(animate)
