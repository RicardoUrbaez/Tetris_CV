# Tetris Hands - Python CV Backend

This optional Python script provides a separate computer vision debug backend for Tetris Hands using OpenCV and Google MediaPipe Hands. The browser app also has built-in MediaPipe hand controls, so use this Python backend mainly for debugging, fallback testing, or camera diagnostics.

## Installation

Install Python dependencies:

```bash
pip install -r requirements.txt
```

Or manually:

```bash
pip install opencv-python mediapipe python-socketio numpy
```

## Usage

1. Make sure the Node.js server is running on `http://localhost:3000`.
2. Run the Python CV backend:

```bash
python cv/gesture_controller.py
```

On Windows:

```bash
py cv\gesture_controller.py
```

The script will:

- Connect to the Node.js server via Socket.IO
- Open your webcam, trying indexes 0, 1, 2, 3, and 4
- Show a debug window with detected gestures
- Send gesture actions to the browser game

## Gestures

- **Swipe LEFT**: Move index finger left quickly -> move piece left
- **Swipe RIGHT**: Move index finger right quickly -> move piece right
- **Fist + Tilt Clockwise**: Rotate piece clockwise
- **Fist + Tilt Counter-Clockwise**: Rotate piece counter-clockwise

For the default browser controls, tune `public/gestureConfig.js`.

## Train Rotation For Your Hand

From the project root, run:

```bash
py cv\train_gestures.py
```

Or:

```bash
python cv/train_gestures.py
```

The trainer opens a camera window and waits for you to click **START** before each capture step. Each new run clears old image sessions first, then captures 600 clockwise rotation images, 600 counter-clockwise rotation images, and 600 flat-hand wave-down soft-drop images. It saves browser-ready calibration data to `public/gestureTraining.js`, a readable copy to `cv/gesture_training.json`, and the image dataset under `cv/training_data/session_YYYYMMDD_HHMMSS/`.

To recalibrate only one control:

```bash
py cv\train_gestures.py --mode rotation
py cv\train_gestures.py --mode soft-drop
```

## Controls

- Press `q` in the OpenCV window to quit.
- The script automatically handles camera fallback if index 0 fails.

## Troubleshooting

- **Camera not opening**: Close other apps using the camera. On Windows, the script tries DirectShow, Media Foundation, and OpenCV's default backend.
- **Wrong camera opens**: Set `TETRIS_CAMERA_INDEX` before starting, for example `$env:TETRIS_CAMERA_INDEX=1` in PowerShell.
- **Connection failed**: Make sure `npm start` is running on port 3000.
- **No gestures detected**: Use good lighting and keep your hand visible in frame.
