import * as THREE from 'three/webgpu'

const { vec3, Fn, time, texture3D, screenUV, uniform, screenCoordinate, pass } = THREE.TSL
import { bayer16 } from 'three/addons/tsl/math/Bayer.js'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js'

export const LAYER_VOLUMETRIC_LIGHTING = 10

function createTexture3D() {
  let i = 0
  const size = 128
  const data = new Uint8Array(size * size * size)
  const scale = 10
  const perlin = new ImprovedNoise()
  const repeatFactor = 5.0
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const nx = (x / size) * repeatFactor
        const ny = (y / size) * repeatFactor
        const nz = (z / size) * repeatFactor
        const noiseValue = perlin.noise(nx * scale, ny * scale, nz * scale)
        data[i++] = 128 + 128 * noiseValue
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, size, size, size)
  texture.format = THREE.RedFormat
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

export function setupVolumetricLighting(renderer, scene, camera) {
  const noiseTexture3D = createTexture3D()
  const smokeAmount = uniform(1.4)
  const volumetricLightingIntensity = uniform(0)
  const denoiseStrength = uniform(0.6)

  const volumetricMaterial = new THREE.VolumeNodeMaterial()
  volumetricMaterial.steps = 12
  volumetricMaterial.offsetNode = bayer16(screenCoordinate)
  volumetricMaterial.scatteringNode = Fn(({ positionRay }) => {
    const timeScaled = vec3(time, 0, time.mul(0.3))
    const sampleGrain = (s, timeScale = 1) => texture3D(
      noiseTexture3D,
      positionRay.add(timeScaled.mul(timeScale)).mul(s).mod(1),
      0,
    ).r.add(0.5)
    let density = sampleGrain(0.1)
    density = density.mul(sampleGrain(0.05, 1))
    density = density.mul(sampleGrain(0.02, 2))
    return smokeAmount.mix(1, density)
  })

  const volumetricMesh = new THREE.Mesh(
    new THREE.BoxGeometry(64, 20, 48),
    volumetricMaterial,
  )
  volumetricMesh.receiveShadow = true
  volumetricMesh.position.set(0, 8, 0)
  volumetricMesh.layers.disableAll()
  volumetricMesh.layers.enable(LAYER_VOLUMETRIC_LIGHTING)
  scene.add(volumetricMesh)

  const renderPipeline = new THREE.RenderPipeline(renderer)
  const scenePass = pass(scene, camera)
  const sceneDepth = scenePass.getTextureNode('depth')
  volumetricMaterial.depthNode = sceneDepth.sample(screenUV)

  const volumetricLayer = new THREE.Layers()
  volumetricLayer.disableAll()
  volumetricLayer.enable(LAYER_VOLUMETRIC_LIGHTING)
  const volumetricPass = pass(scene, camera, { depthBuffer: false })
  volumetricPass.setLayers(volumetricLayer)
  volumetricPass.setResolutionScale(0.25)

  const blurredVolumetricPass = gaussianBlur(volumetricPass, denoiseStrength)
  renderPipeline.outputNode = scenePass.add(
    blurredVolumetricPass.mul(volumetricLightingIntensity),
  )

  function setEnabled(enabled, intensity = 1.0) {
    volumetricMesh.visible = enabled
    volumetricLightingIntensity.value = enabled ? intensity : 0
  }

  function setSmoke(value) {
    smokeAmount.value = value
  }

  return { renderPipeline, volumetricMesh, setEnabled, setSmoke }
}

export function enableLightForVolumetrics(light, enabled) {
  if (enabled) light.layers.enable(LAYER_VOLUMETRIC_LIGHTING)
  else light.layers.disable(LAYER_VOLUMETRIC_LIGHTING)
}