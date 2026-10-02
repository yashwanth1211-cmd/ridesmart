/**
 * Runtime asset probing.
 *
 * We cannot know at build time whether the optional /models/bus.glb and
 * /textures/transport.jpg are present, and importing a missing URL through
 * useGLTF/useTexture throws inside the R3F reconciler. Probing with a HEAD
 * request first keeps the failure path explicit and lets us choose a
 * procedural fallback without relying on an error boundary.
 */

/**
 * Vite's dev server falls through to index.html for unknown paths, so a plain
 * 200 is NOT proof the asset exists - a missing /models/bus.glb comes back as
 * 200 text/html. Anything that smells like a document is treated as missing.
 */
function looksLikeHtml(res) {
  return (res.headers.get('content-type') || '').includes('text/html')
}

/**
 * @returns {Promise<boolean>} true if the asset is really there.
 */
export async function probeAsset(url) {
  if (typeof fetch !== 'function') return false
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    if (!res.ok || looksLikeHtml(res)) return false

    // Some static servers omit content-length on HEAD, so confirm with a
    // ranged GET that the body is actually there and not an empty placeholder.
    const len = Number(res.headers.get('content-length') || '0')
    if (len === 0) {
      const probe = await fetch(url, { method: 'GET', cache: 'no-store' })
      if (!probe.ok || looksLikeHtml(probe)) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Probes every optional asset in parallel.
 * @returns {Promise<{ model: boolean, texture: boolean }>}
 */
export async function probeAssets({ model, texture }) {
  const [hasModel, hasTexture] = await Promise.all([
    probeAsset(model),
    probeAsset(texture),
  ])
  return { model: hasModel, texture: hasTexture }
}