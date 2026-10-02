import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useGLTF } from '@react-three/drei'
import { MODEL } from '@/config/constants'

/**
 * Real .glb bus. Only mounted once the HEAD probe in src/lib/assets.js has
 * confirmed the file exists, so useGLTF never throws on a 404.
 *
 * Node discovery is deliberately tolerant:
 *   - a node counts as a wheel if it matches any name in MODEL.wheelNodes
 *   - a node counts as a door  if it matches any name in MODEL.doorNodes
 * Anything unmatched is left alone and still renders.
 *
 * Wheels get re-parented under a pivot that sits at their world transform, so
 * rolling them is a single `pivot.rotation.x = spin` regardless of how the
 * wheel was oriented inside the file.
 */

const norm = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

function matches(name, candidates) {
  const clean = norm(name)
  return candidates.some((candidate) => norm(candidate) === clean)
}

export default function GlbBus() {
  const { scene } = useGLTF(MODEL.url)

  const model = useMemo(() => {
    const clone = scene.clone(true)
    clone.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true
        node.receiveShadow = true
      }
    })
    return clone
  }, [scene])

  useLayoutEffect(() => {
    // Collect first, mutate after - re-parenting mid-traverse skips subtrees.
    const wheelNodes = []
    const doorNodes = []

    model.traverse((node) => {
      if (!node.name) return
      if (matches(node.name, MODEL.wheelNodes)) wheelNodes.push(node)
      else if (matches(node.name, MODEL.doorNodes)) doorNodes.push(node)
    })

    // Force world matrices to settle before we re-parent anything.
    model.updateWorldMatrix(true, true)

    wheelNodes.forEach((node) => {
      if (!node.parent) return
      const pivot = new THREE.Group()
      pivot.userData.wheel = true
      pivot.name = `${node.name}_pivot`
      model.add(pivot)
      // attach() preserves the node's world transform, so the wheel does not move.
      pivot.attach(node)
    })

    doorNodes.forEach((node) => {
      node.userData.door = true
      node.userData.axis = MODEL.doorAxis
      node.userData.openAngle = MODEL.doorOpenDelta
    })

    if (wheelNodes.length === 0 || doorNodes.length === 0) {
      // Not fatal - just worth knowing, since it means the door will not open.
      console.info(
        `[ridesmart] bus.glb loaded. matched ${wheelNodes.length} wheel node(s), ` +
          `${doorNodes.length} door node(s). Expected names are in MODEL in src/config/constants.js.`,
      )
    }
  }, [model])

  return <primitive object={model} />
}