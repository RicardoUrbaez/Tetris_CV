(function () {
  "use strict";

  window.TETRIS_HANDS_GESTURE_TRAINING = {
  "rotation": {
    "gesture": "pinch",
    "pinchEnterRatio": 0.34,
    "pinchExitRatio": 0.48,
    "triggerDeg": 25,
    "releaseDeg": 12,
    "debounceMs": 280,
    "cwDirection": 1,
    "classifierConfidence": 0.78
  },
  "softDrop": {
    "gesture": "trained_flat_hand_wave_down",
    "waveDownThreshold": 0.038,
    "waveWindowMs": 180,
    "repeatMs": 80,
    "holdMs": 650,
    "requireOpenPalm": false
  },
  "trainingMeta": {
    "rotationStatus": "kept_previous_rotation",
    "softDropImages": 600,
    "datasetDir": "cv\\training_data\\session_20260620_005144",
    "classes": {
      "soft_drop_wave_down": {
        "imageCount": 600,
        "imageDir": "cv\\training_data\\session_20260620_005144\\soft_drop_wave_down",
        "waveDownThreshold": 0.038,
        "medianPalmY": 0.5447
      }
    },
    "createdAt": "2026-06-20 00:52:37"
  }
};
})();
