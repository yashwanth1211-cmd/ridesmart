import * as THREE from 'three'

/**
 * Procedural canvas textures. These exist so the scene has zero hard
 * dependencies beyond the optional backdrop photo - if transport.jpg is
 * missing the environment still reads as golden hour.
 */

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function finish(canvas, { repeat, anisotropy = 8, colorSpace = THREE.SRGBColorSpace }) {
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.anisotropy = anisotropy
  texture.colorSpace = colorSpace
  if (repeat) texture.repeat.set(repeat[0], repeat[1])
  texture.needsUpdate = true
  return texture
}

/**
 * Vertical golden-hour sky: deep blue up top, warm haze through the middle,
 * orange at the horizon. Used when the backdrop photo is unavailable.
 */
export function createSkyGradient({ width = 64, height = 512 } = {}) {
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const gradient = ctx.createLinearGradient(0, 0, 0, height)

  gradient.addColorStop(0.0, '#1f3a63')
  gradient.addColorStop(0.28, '#4a6a94')
  gradient.addColorStop(0.52, '#c98f63')
  gradient.addColorStop(0.7, '#ffb067')
  gradient.addColorStop(0.86, '#ffd9a0')
  gradient.addColorStop(1.0, '#e8a468')

  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  return finish(canvas, { anisotropy: 2 })
}

/**
 * Asphalt with lane markings, a kerb line and subtle patchiness.
 * Tiles along V so it repeats down the length of the road.
 */
export function createRoadTexture({ road, size = 1024 } = {}) {
  const canvas = makeCanvas(size, size)
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = road.color
  ctx.fillRect(0, 0, size, size)

  // Aggregate speckle so the surface is not a flat fill under the key light.
  const speckles = Math.round(size * 5)
  for (let i = 0; i < speckles; i += 1) {
    const x = Math.random() * size
    const y = Math.random() * size
    const r = Math.random() * 1.6 + 0.3
    const shade = Math.random() > 0.5 ? '255,255,255' : '0,0,0'
    ctx.fillStyle = `rgba(${shade},${Math.random() * 0.06})`
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }

  // Darker wheel tracks where vehicles run.
  ctx.fillStyle = 'rgba(0,0,0,0.16)'
  for (const x of [size * 0.34, size * 0.66]) {
    ctx.fillRect(x - 26, 0, 52, size)
  }

  // Dashed centre line. The gap between dashes is implicit - the texture tiles
  // every 8 units of `unit`, so dashing comes out of the loop stride.
  const [dashLength] = road.lanes.dash
  const unit = size / 8
  ctx.fillStyle = road.lanes.color
  for (let y = 0; y < size; y += dashLength * unit) {
    ctx.fillRect(size * 0.5 - road.lanes.width * unit, y, road.lanes.width * 2, dashLength * unit)
  }

  // Solid edge line on the passenger side.
  ctx.fillRect(size * 0.93, 0, road.lanes.width * 1.4, size)

  // Kerb paving.
  ctx.fillStyle = road.kerb.color
  ctx.fillRect(size * 0.96, 0, size * 0.04, size)
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'
  ctx.lineWidth = 2
  for (let y = 0; y < size; y += size / 32) {
    ctx.beginPath()
    ctx.moveTo(size * 0.96, y)
    ctx.lineTo(size, y)
    ctx.stroke()
  }

  return finish(canvas, { anisotropy: 16 })
}

/**
 * Tinted glass for the procedural bus windows - a soft vertical sheen so the
 * saloon does not read as a black void from outside.
 */
export function createWindowTexture({ width = 256, height = 256 } = {}) {
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')

  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, '#8fb4d9')
  gradient.addColorStop(0.42, '#c9dcea')
  gradient.addColorStop(0.55, '#e8f1f8')
  gradient.addColorStop(1, '#6f8aa8')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)

  // Raking highlight.
  ctx.globalAlpha = 0.35
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.moveTo(0, height * 0.62)
  ctx.lineTo(width, height * 0.28)
  ctx.lineTo(width, height * 0.5)
  ctx.lineTo(0, height * 0.86)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 1

  return finish(canvas, { anisotropy: 4 })
}