#!/usr/bin/env python3
"""
Tetris Hands - Python CV Backend
Uses OpenCV + MediaPipe Hands (Tasks API) for robust gesture detection
Sends actions to Node.js server via Socket.IO
"""

import cv2
import socketio
import time
import numpy as np
import os
from collections import deque
from typing import Optional, Tuple

# ======================
# MediaPipe Import (Tasks API for 0.10+)
# ======================
try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
    from mediapipe.tasks.python.core import base_options
    
    # Use HandLandmarker from Tasks API
    HandLandmarker = vision.HandLandmarker
    HandLandmarkerOptions = vision.HandLandmarkerOptions
    HandLandmarkerResult = vision.HandLandmarkerResult
    VisionRunningMode = mp.tasks.vision.RunningMode
    BaseOptions = base_options.BaseOptions
    
    print("[CV] MediaPipe 0.10+ Tasks API detected")
except ImportError as e:
    print(f"[ERROR] MediaPipe import failed: {e}")
    print("[ERROR] Please install MediaPipe: pip install mediapipe")
    import traceback
    traceback.print_exc()
    exit(1)

# ======================
# Configuration
# ======================
SWIPE_THRESHOLD = 0.12  # Normalized distance (12% of frame width)
SWIPE_VELOCITY_MIN = 0.3  # Minimum velocity for swipe
SWIPE_COOLDOWN_MS = 200  # Cooldown between swipes
ROTATE_THRESHOLD_DEG = 15  # Degrees of tilt to trigger rotate
ROTATE_HYSTERESIS_DEG = 8  # Hysteresis for rotate
ROTATE_COOLDOWN_MS = 250  # Cooldown between rotates
FIST_FRAMES_REQUIRED = 3  # Frames of fist detection required
SMOOTH_ALPHA = 0.8  # EMA smoothing factor
CAMERA_INDEXES = [0, 1, 2, 3, 4]
CAMERA_WARMUP_FRAMES = 8

# ======================
# Socket.IO Client
# ======================
sio = socketio.Client()
connected = False

@sio.event
def connect():
    global connected
    connected = True
    print("[Socket.IO] Connected to Node.js server")

@sio.event
def disconnect():
    global connected
    connected = False
    print("[Socket.IO] Disconnected from server")

# ======================
# Gesture State
# ======================
class GestureState:
    def __init__(self):
        # Smoothed positions (EMA)
        self.sm_palm_x = 0.5
        self.sm_palm_y = 0.5
        self.sm_roll = 0.0
        
        # Swipe detection
        self.swipe_samples = deque(maxlen=8)  # (timestamp, x)
        self.swipe_lock_until = 0
        self.swipe_neutral_ready = True
        
        # Fist + rotate detection
        self.fist_streak = 0
        self.fist_active = False
        self.neutral_angle = None
        self.rotate_armed = True
        self.rotate_lock_until = 0
        
        # Last action timestamp
        self.last_action_ts = 0

gesture = GestureState()

# ======================
# MediaPipe Setup (Tasks API)
# ======================
import os

def get_model_path():
    """Get or download MediaPipe hand landmarker model"""
    try:
        import mediapipe as mp
        mp_dir = os.path.dirname(mp.__file__)
        # Try to find bundled model
        possible_paths = [
            os.path.join(mp_dir, 'modules', 'hand_landmarker', 'hand_landmarker.task'),
            os.path.join(mp_dir, 'tasks', 'models', 'hand_landmarker.task'),
        ]
        for path in possible_paths:
            if os.path.exists(path):
                return path
        # Download model if not found
        model_dir = os.path.dirname(__file__)
        model_path = os.path.join(model_dir, "hand_landmarker.task")
        if not os.path.exists(model_path):
            print("[CV] Model not found, downloading default model...")
            import urllib.request
            model_url = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"
            print(f"[CV] Downloading from: {model_url}")
            urllib.request.urlretrieve(model_url, model_path)
            print(f"[CV] Model downloaded to: {model_path}")
        return model_path
    except Exception as e:
        print(f"[WARNING] Could not find/download model: {e}")
        return None

try:
    model_path = get_model_path()
    if model_path and os.path.exists(model_path):
        print(f"[CV] Using model at: {model_path}")
        base_opts = BaseOptions(model_asset_path=model_path)
    else:
        print("[ERROR] Could not find or download model file")
        print("[ERROR] Please download hand_landmarker.task manually or check MediaPipe installation")
        exit(1)
    
    options = HandLandmarkerOptions(
        base_options=base_opts,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        running_mode=VisionRunningMode.IMAGE
    )
    hand_landmarker = HandLandmarker.create_from_options(options)
    print("[CV] MediaPipe HandLandmarker initialized successfully")
except Exception as e:
    print(f"[ERROR] Failed to initialize MediaPipe HandLandmarker: {e}")
    print("[ERROR] Make sure MediaPipe is properly installed")
    import traceback
    traceback.print_exc()
    exit(1)

# ======================
# Camera Setup
# ======================
def open_camera():
    """Open camera with fallback indexes and Windows-friendly backends."""
    requested_index = os.environ.get("TETRIS_CAMERA_INDEX")
    indexes = CAMERA_INDEXES[:]
    if requested_index is not None:
        try:
            preferred = int(requested_index)
            indexes = [preferred] + [idx for idx in indexes if idx != preferred]
        except ValueError:
            print(f"[Camera] Ignoring invalid TETRIS_CAMERA_INDEX={requested_index!r}")

    backends = [cv2.CAP_ANY]
    if os.name == "nt":
        backends = [cv2.CAP_DSHOW, cv2.CAP_MSMF, cv2.CAP_ANY]

    for backend in backends:
        for idx in indexes:
            cap = cv2.VideoCapture(idx, backend)
            if not cap.isOpened():
                cap.release()
                continue

            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FPS, 30)

            for _ in range(CAMERA_WARMUP_FRAMES):
                cap.read()

            ret, frame = cap.read()
            if ret and frame is not None:
                backend_name = "default" if backend == cv2.CAP_ANY else str(backend)
                print(f"[Camera] Opened camera index {idx} with backend {backend_name}")
                return cap

            cap.release()
    raise RuntimeError("Could not open any camera")

cap = None

# ======================
# Gesture Detection Functions
# ======================
def palm_center(landmarks):
    """Compute palm center from key landmarks"""
    idx = [0, 5, 9, 13, 17]  # wrist, index MCP, middle MCP, ring MCP, pinky MCP
    x = sum(landmarks[idx].x for idx in idx) / len(idx)
    y = sum(landmarks[idx].y for idx in idx) / len(idx)
    return x, y

def is_fist(landmarks):
    """Detect if hand is making a fist"""
    wrist = landmarks[0]
    fingertips = [8, 12, 16, 20]  # index, middle, ring, pinky tips
    mcps = [5, 9, 13, 17]  # MCP joints
    
    curled = 0
    for tip_idx, mcp_idx in zip(fingertips, mcps):
        tip = landmarks[tip_idx]
        mcp = landmarks[mcp_idx]
        
        # Distance from tip to wrist vs MCP to wrist
        tip_dist = np.sqrt((tip.x - wrist.x)**2 + (tip.y - wrist.y)**2)
        mcp_dist = np.sqrt((mcp.x - wrist.x)**2 + (mcp.y - wrist.y)**2)
        
        # Fingertip closer to wrist than MCP = curled
        if tip_dist < mcp_dist * 0.85:
            curled += 1
    
    return curled >= 3

def roll_angle(landmarks):
    """Compute wrist roll/tilt angle"""
    wrist = landmarks[0]
    middle_mcp = landmarks[9]
    dx = middle_mcp.x - wrist.x
    dy = middle_mcp.y - wrist.y
    return np.arctan2(dy, dx)

def smooth_ema(prev, current, alpha=SMOOTH_ALPHA):
    """Exponential moving average"""
    return prev + (current - prev) * alpha

def detect_swipe(now_ms):
    """Detect left/right swipe gesture"""
    if now_ms < gesture.swipe_lock_until:
        return None
    
    if len(gesture.swipe_samples) < 3:
        return None
    
    # Use last 6 samples for detection
    window_size = min(6, len(gesture.swipe_samples))
    latest = gesture.swipe_samples[-1]
    ref = gesture.swipe_samples[-window_size]
    
    dx = latest[1] - ref[1]  # x difference
    dt = max(1, latest[0] - ref[0])  # time difference in ms
    velocity = abs(dx) / (dt / 1000.0)  # velocity in normalized units per second
    
    # Check return to neutral
    if not gesture.swipe_neutral_ready:
        if len(gesture.swipe_samples) >= 2:
            inst_vel = abs(gesture.swipe_samples[-1][1] - gesture.swipe_samples[-2][1]) / 0.033  # ~30fps
            if inst_vel < 0.1:
                gesture.swipe_neutral_ready = True
        return None
    
    # Trigger swipe if thresholds met
    if abs(dx) > SWIPE_THRESHOLD and dt <= 250 and velocity > SWIPE_VELOCITY_MIN:
        gesture.swipe_lock_until = now_ms + SWIPE_COOLDOWN_MS
        gesture.swipe_neutral_ready = False
        direction = "LEFT" if dx < 0 else "RIGHT"
        print(f"[Gesture] Swipe {direction}: dx={dx:.3f}, vel={velocity:.2f}")
        return direction
    
    return None

def detect_rotate(landmarks, now_ms):
    """Detect clockwise/counter-clockwise rotate gesture (fist + wrist tilt)."""
    fist_now = is_fist(landmarks)
    
    if fist_now:
        gesture.fist_streak += 1
    else:
        gesture.fist_streak = 0
    
    gesture.fist_active = gesture.fist_streak >= FIST_FRAMES_REQUIRED
    
    if not gesture.fist_active:
        gesture.neutral_angle = None
        gesture.rotate_armed = True
        return None
    
    # Compute tilt angle
    raw_roll = roll_angle(landmarks)
    gesture.sm_roll = smooth_ema(gesture.sm_roll, raw_roll, 0.75)
    
    # Set neutral angle when fist first becomes active
    if gesture.neutral_angle is None or abs(gesture.sm_roll - gesture.neutral_angle) > np.pi / 2:
        gesture.neutral_angle = gesture.sm_roll
    
    # Compute delta angle (normalized to -PI to PI)
    delta = gesture.sm_roll - gesture.neutral_angle
    delta = np.arctan2(np.sin(delta), np.cos(delta))
    delta_deg = np.degrees(delta)
    
    # Trigger rotate when delta exceeds threshold (clockwise tilt)
    if gesture.rotate_armed and now_ms > gesture.rotate_lock_until and delta_deg > ROTATE_THRESHOLD_DEG:
        gesture.rotate_armed = False
        gesture.rotate_lock_until = now_ms + ROTATE_COOLDOWN_MS
        print(f"[Gesture] Rotate: delta={delta_deg:.1f}°")
        return "ROTATE_CW"

    if gesture.rotate_armed and now_ms > gesture.rotate_lock_until and delta_deg < -ROTATE_THRESHOLD_DEG:
        gesture.rotate_armed = False
        gesture.rotate_lock_until = now_ms + ROTATE_COOLDOWN_MS
        print(f"[Gesture] Rotate CCW: delta={delta_deg:.1f} deg")
        return "ROTATE_CCW"
    
    # Re-arm when delta returns below hysteresis threshold
    if abs(delta_deg) < ROTATE_HYSTERESIS_DEG:
        gesture.rotate_armed = True
    
    return None


# ======================
# Main Loop
# ======================
def main():
    global cap
    
    print("[CV] Starting Tetris Hands CV Backend...")
    
    # Connect to Node.js server
    print("[CV] Connecting to Node.js server at http://localhost:3000...")
    try:
        sio.connect('http://localhost:3000', wait_timeout=10, transports=['websocket', 'polling'])
        # Wait a moment for connection to establish
        import time
        time.sleep(1)
        if not connected:
            print("[ERROR] Failed to connect to Node.js server")
            print("[ERROR] Make sure server.js is running: npm start")
            print("[ERROR] Check that port 3000 is not blocked by firewall")
            return
        print("[CV] Successfully connected to Node.js server!")
    except Exception as e:
        print(f"[ERROR] Socket.IO connection failed: {e}")
        print("[ERROR] Troubleshooting:")
        print("  1. Make sure Node.js server is running: npm start")
        print("  2. Check that server is listening on http://localhost:3000")
        print("  3. Verify no firewall is blocking the connection")
        print("  4. Try restarting the Node.js server")
        return
    
    # Open camera
    try:
        cap = open_camera()
    except Exception as e:
        print(f"[ERROR] Camera failed: {e}")
        sio.disconnect()
        return
    
    print("[CV] Starting gesture detection loop...")
    print("[CV] Press 'q' in OpenCV window to quit")
    
    frame_count = 0
    fps_start = time.time()
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("[ERROR] Failed to read frame")
                break
            
            # Flip horizontally for mirror view
            frame = cv2.flip(frame, 1)
            
            # Convert to MediaPipe Image format
            rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
            
            # Detect hands
            detection_result = hand_landmarker.detect(mp_image)
            
            # Get current time
            now_ms = int(time.time() * 1000)
            
            # Process gestures if hand detected
            action = None
            gesture_label = "No hand"
            
            if detection_result.hand_landmarks and len(detection_result.hand_landmarks) > 0:
                landmarks = detection_result.hand_landmarks[0]
                
                # Update smoothed palm position
                palm_x, palm_y = palm_center(landmarks)
                gesture.sm_palm_x = smooth_ema(gesture.sm_palm_x, palm_x)
                gesture.sm_palm_y = smooth_ema(gesture.sm_palm_y, palm_y)
                
                # Add swipe sample
                gesture.swipe_samples.append((now_ms, gesture.sm_palm_x))

                # Detect swipe
                swipe = detect_swipe(now_ms)
                if swipe:
                    action = swipe
                    gesture_label = f"Swipe {swipe}"
                
                # Detect rotate (if no swipe)
                if not action:
                    rotate = detect_rotate(landmarks, now_ms)
                    if rotate:
                        action = rotate
                        gesture_label = rotate.replace("_", " ").title()
                    elif gesture.fist_active:
                        gesture_label = "Fist (tilt to rotate)"
                    else:
                        gesture_label = "Hand detected"
                
                # Draw landmarks as circles
                h, w = frame.shape[:2]
                for landmark in landmarks:
                    x, y = int(landmark.x * w), int(landmark.y * h)
                    cv2.circle(frame, (x, y), 3, (0, 255, 0), -1)
            
            # Send action to server
            if action and connected:
                sio.emit('cv-action', {
                    'action': action,
                    'ts': now_ms
                })
                gesture.last_action_ts = now_ms
            
            # Draw debug info
            h, w = frame.shape[:2]
            cv2.putText(frame, gesture_label, (10, 30),
                       cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
            
            if gesture.fist_active:
                cv2.putText(frame, f"Fist: ON (tilt: {np.degrees(gesture.sm_roll - (gesture.neutral_angle or 0)):.1f}°)",
                           (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
            
            # FPS counter
            frame_count += 1
            if frame_count % 30 == 0:
                fps = 30 / (time.time() - fps_start)
                fps_start = time.time()
                cv2.putText(frame, f"FPS: {fps:.1f}", (w - 120, 30),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
            
            # Show frame
            cv2.imshow('Tetris Hands CV', frame)
            
            # Quit on 'q'
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    
    except KeyboardInterrupt:
        print("\n[CV] Interrupted by user")
    finally:
        # Cleanup
        if cap:
            cap.release()
        cv2.destroyAllWindows()
        if connected:
            sio.disconnect()
        print("[CV] Shutdown complete")

if __name__ == "__main__":
    main()
