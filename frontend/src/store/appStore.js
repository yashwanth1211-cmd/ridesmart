import { create } from 'zustand'
import { APP_STATE } from '@/config/constants'

/**
 * Global state machine for the boarding sequence.
 *
 *   LOADING -> ARRIVING -> STOPPED -> ENTERING -> DASHBOARD
 *
 * Only low-frequency values live here. Anything that changes every frame
 * (wheel spin, camera position) is kept in refs inside the 3D components and
 * driven from useFrame, because routing 60 fps through React would re-render
 * the whole dashboard for nothing.
 */
const ORDER = [
  APP_STATE.LOADING,
  APP_STATE.ARRIVING,
  APP_STATE.STOPPED,
  APP_STATE.ENTERING,
  APP_STATE.DASHBOARD,
]

export const useAppStore = create((set, get) => ({
  // ---- state machine -----------------------------------------------------
  state: APP_STATE.LOADING,

  /** drei's useProgress payload, mirrored so the DOM loader can read it. */
  progress: { active: false, loaded: 0, total: 0, item: null },

  /** True once the GLTF probe has resolved (either way - file or fallback). */
  assetsReady: false,

  /** 'glb' when public/models/bus.glb was found, 'proxy' for the procedural bus. */
  modelSource: null,

  /** Set when the user presses "Skip intro". Components snap, then clear it. */
  skipRequested: false,

  /** Mirror of the door state, for HUD copy only. */
  doorOpen: false,

  /** 0..1 progress of the camera journey, for the HUD progress bar. */
  journeyProgress: 0,

  /**
   * Bumped whenever the dashboard's live data changes. The 3D canvas runs on
   * demand once the sequence ends, so this is how it gets told to repaint.
   */
  dataVersion: 0,

  /** True once the dashboard is mounted and accepting pointer events. */
  interactive: false,

  /** Honours prefers-reduced-motion by collapsing the sequence. */
  reducedMotion: false,

  // ---- actions -----------------------------------------------------------

  /**
   * Advances the machine one step at a time. Backwards transitions are ignored
   * unless `force` is set (replay does that), because a stray late callback
   * dropping the state from DASHBOARD back to STOPPED would leave the
   * dashboard on screen with the camera still parked inside the bus.
   */
  setState: (state, { force = false } = {}) => {
    const current = get().state
    if (current === state) return
    if (!force && ORDER.indexOf(state) < ORDER.indexOf(current)) return

    set({
      state,
      interactive: state === APP_STATE.DASHBOARD,
      ...(state === APP_STATE.ENTERING ? { journeyProgress: 0 } : null),
    })
  },

  setProgress: (progress) => set({ progress }),
  setAssetsReady: (assetsReady) => set({ assetsReady }),
  setModelSource: (modelSource) => set({ modelSource }),
  setDoorOpen: (doorOpen) => set({ doorOpen }),
  setJourneyProgress: (journeyProgress) => set({ journeyProgress }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  bumpDataVersion: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),

  /**
   * Collapse the whole sequence straight to the dashboard.
   * The 3D components observe `skipRequested` and hard-snap their transforms,
   * then call clearSkip() - so this stays free of animation concerns.
   */
  skipIntro: () =>
    set({ skipRequested: true, state: APP_STATE.DASHBOARD, interactive: true, journeyProgress: 1 }),

  clearSkip: () => set({ skipRequested: false }),

  /**
   * Re-run the sequence from the top.
   *
   * Goes straight to ARRIVING rather than LOADING: the assets are already in
   * memory, and only the AssetGate (which runs once, inside Suspense) promotes
   * LOADING -> ARRIVING. Sending it back to LOADING would strand the replay.
   * Bus.jsx and CameraJourney.jsx both watch for the ARRIVING edge and reset
   * their own transforms.
   */
  replay: () =>
    set({
      state: APP_STATE.ARRIVING,
      doorOpen: false,
      journeyProgress: 0,
      interactive: false,
      skipRequested: false,
    }),

  /** Wipes state back to a cold LOADING. Only safe on a fresh mount. */
  reset: () =>
    set({
      state: APP_STATE.LOADING,
      doorOpen: false,
      journeyProgress: 0,
      interactive: false,
      skipRequested: false,
      progress: { active: false, loaded: 0, total: 0, item: null },
    }),
}))

/** Convenience selectors - importing these keeps components re-render scoped. */
export const selectState = (s) => s.state
export const selectIsInteractive = (s) => s.interactive
export const selectSkipRequested = (s) => s.skipRequested