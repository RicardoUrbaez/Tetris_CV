(function () {
  "use strict";

  window.TETRIS_HANDS_GESTURES = {
    camera: {
      width: 640,
      height: 480,
      frameMs: 33
    },

    movement: {
      invertLeftRight: true,
      emaAlpha: 0.28,
      leftEnter: 0.45,
      leftExit: 0.52,
      rightEnter: 0.55,
      rightExit: 0.48,
      repeatMs: 160
    },

    rotation: {
      gesture: "pinch",
      pinchEnterRatio: 0.34,
      pinchExitRatio: 0.48,
      triggerDeg: 25,
      releaseDeg: 12,
      debounceMs: 280,
      cwDirection: 1
    },

    softDrop: {
      waveDownThreshold: 0.10,
      waveWindowMs: 180,
      repeatMs: 80,
      holdMs: 650,
      requireOpenPalm: false
    },

    optional: {
      openPalmTipMcpMin: 0.12,
      vSignHoldMs: 400,
      pauseDebounceMs: 800,
      clapDistanceRatio: 2.35,
      clapRearmDistanceRatio: 3.4,
      clapMinClosingRatio: 0.75,
      clapMaxVerticalRatio: 1.35,
      clapWindowMs: 260,
      clapCooldownMs: 1400
    }
  };
})();
