#!/usr/bin/env python3
"""
Calibrate Tetris Hands gesture controls.

This does not retrain Google's MediaPipe model. MediaPipe detects hand landmarks;
this script captures 600 images for each trained motion, learns your neutral,
pinch clockwise, pinch counter-clockwise, and flat-hand down-wave movements, and writes those
settings into public/gestureTraining.js for the browser app.
"""

import csv
import argparse
import json
import math
import os
import re
import shutil
import statistics
import time
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import vision
from mediapipe.tasks.python.core import base_options


ROOT_DIR = Path(__file__).resolve().parents[1]
MODEL_PATH = Path(__file__).resolve().parent / "hand_landmarker.task"
OUTPUT_JS = ROOT_DIR / "public" / "gestureTraining.js"
OUTPUT_JSON = Path(__file__).resolve().parent / "gesture_training.json"
OUTPUT_SAMPLES_JS = ROOT_DIR / "public" / "gestureSamples.js"
DATASET_DIR = Path(__file__).resolve().parent / "training_data"

SAMPLE_SECONDS = 3.0
ROTATION_IMAGES_PER_MOTION = 600
SOFT_DROP_IMAGES = 600
CAMERA_INDEXES = [0, 1, 2, 3, 4]
CAMERA_WARMUP_FRAMES = 8
WINDOW_NAME = "Tetris Hands Gesture Training"

START_BUTTON = {
    "x1": 210,
    "y1": 170,
    "x2": 430,
    "y2": 250,
}

start_requested = False
classifier_samples = []

DEFAULT_ROTATION_TRAINING = {
    "gesture": "pinch",
    "pinchEnterRatio": 0.34,
    "pinchExitRatio": 0.48,
    "triggerDeg": 25,
    "releaseDeg": 12,
    "debounceMs": 280,
    "cwDirection": 1,
    "classifierConfidence": 0.78,
}

DEFAULT_SOFT_DROP_TRAINING = {
    "gesture": "flat_hand_wave_down",
    "waveDownThreshold": 0.10,
    "waveWindowMs": 180,
    "repeatMs": 80,
    "holdMs": 650,
    "requireOpenPalm": True,
}


def parse_args():
    parser = argparse.ArgumentParser(description="Calibrate Tetris Hands gestures.")
    parser.add_argument(
        "--mode",
        choices=["all", "rotation", "soft-drop"],
        default="all",
        help="Choose which gesture group to recalibrate.",
    )
    return parser.parse_args()


def wrap_deg(angle):
    while angle > 180:
        angle -= 360
    while angle < -180:
        angle += 360
    return angle


def wrist_twist_degrees(landmarks):
    v1x = landmarks[5].x - landmarks[0].x
    v1y = landmarks[5].y - landmarks[0].y
    v2x = landmarks[17].x - landmarks[0].x
    v2y = landmarks[17].y - landmarks[0].y
    a1 = math.atan2(v1y, v1x)
    a2 = math.atan2(v2y, v2x)
    return wrap_deg((a2 - a1) * 180 / math.pi)


def palm_center(landmarks):
    indexes = [0, 5, 9, 13, 17]
    x = sum(landmarks[index].x for index in indexes) / len(indexes)
    y = sum(landmarks[index].y for index in indexes) / len(indexes)
    return x, y


def landmark_feature_vector(landmarks):
    wrist = landmarks[0]
    scale = max(
        math.hypot(landmarks[5].x - wrist.x, landmarks[5].y - wrist.y),
        math.hypot(landmarks[9].x - wrist.x, landmarks[9].y - wrist.y),
        math.hypot(landmarks[17].x - wrist.x, landmarks[17].y - wrist.y),
        0.001,
    )

    features = []
    for landmark in landmarks:
        features.extend([
            round((landmark.x - wrist.x) / scale, 5),
            round((landmark.y - wrist.y) / scale, 5),
            round((landmark.z - wrist.z) / scale, 5),
        ])
    return features


def open_camera():
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
            cap.set(cv2.CAP_PROP_AUTO_WB, 1)

            for _ in range(CAMERA_WARMUP_FRAMES):
                cap.read()

            ret, frame = cap.read()
            if ret and frame is not None:
                print(f"[Camera] Opened camera index {idx}")
                return cap
            cap.release()

    raise RuntimeError("Could not open any camera")


def create_landmarker():
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Missing MediaPipe model: {MODEL_PATH}")

    options = vision.HandLandmarkerOptions(
        base_options=base_options.BaseOptions(model_asset_path=str(MODEL_PATH)),
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
    )
    return vision.HandLandmarker.create_from_options(options)


def detect_features(landmarker, frame):
    rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
    result = landmarker.detect(mp_image)
    if not result.hand_landmarks:
        return None
    landmarks = result.hand_landmarks[0]
    palm_x, palm_y = palm_center(landmarks)
    return {
        "angleDeg": wrist_twist_degrees(landmarks),
        "palmX": palm_x,
        "palmY": palm_y,
        "landmarkFeatures": landmark_feature_vector(landmarks),
    }


def detect_angle(landmarker, frame):
    features = detect_features(landmarker, frame)
    if features is None:
        return None
    return features["angleDeg"]


def remember_classifier_sample(class_name, features):
    classifier_samples.append({
        "label": class_name,
        "features": features["landmarkFeatures"],
    })


def on_mouse(event, x, y, flags, param):
    global start_requested
    if event != cv2.EVENT_LBUTTONDOWN:
        return

    if START_BUTTON["x1"] <= x <= START_BUTTON["x2"] and START_BUTTON["y1"] <= y <= START_BUTTON["y2"]:
        start_requested = True


def draw_start_button(frame, prompt):
    h, w = frame.shape[:2]
    x1 = min(START_BUTTON["x1"], w - 230)
    x2 = min(START_BUTTON["x2"], w - 10)
    y1 = min(START_BUTTON["y1"], h - 120)
    y2 = min(START_BUTTON["y2"], h - 40)

    cv2.rectangle(frame, (0, 0), (w, 124), (0, 0, 0), -1)
    cv2.putText(frame, prompt, (16, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.72, (0, 255, 255), 2)
    cv2.putText(frame, "Position your hand, then click START.", (16, 68), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (255, 255, 255), 2)
    cv2.putText(frame, "Keyboard: S starts, Q cancels.", (16, 98), cv2.FONT_HERSHEY_SIMPLEX, 0.58, (220, 220, 220), 1)

    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 180, 180), -1)
    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 3)
    cv2.putText(frame, "START", (x1 + 45, y1 + 52), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 3)


def wait_for_start(cap, prompt):
    global start_requested
    start_requested = False
    cv2.namedWindow(WINDOW_NAME)
    cv2.setMouseCallback(WINDOW_NAME, on_mouse)

    print(f"\n{prompt}")
    print("Click START in the camera window, or press S when ready.")

    while not start_requested:
        ret, frame = cap.read()
        if not ret:
            continue

        frame = cv2.flip(frame, 1)
        draw_start_button(frame, prompt)
        cv2.imshow(WINDOW_NAME, frame)

        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            raise KeyboardInterrupt
        if key == ord("s"):
            start_requested = True


def overlay(frame, label, seconds_left=None, samples_count=0, target_count=None):
    cv2.putText(frame, label, (16, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
    if target_count is None:
        cv2.putText(frame, f"Recording: {seconds_left:.1f}s", (16, 68), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
        cv2.putText(frame, f"Samples: {samples_count}", (16, 98), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
    else:
        cv2.putText(frame, f"Images: {samples_count}/{target_count}", (16, 68), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
        cv2.putText(frame, "Move naturally through this gesture.", (16, 98), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)
    cv2.putText(frame, "Keep hand visible. Press q to cancel.", (16, frame.shape[0] - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 220, 220), 1)


def capture_stage(cap, landmarker, prompt, seconds=SAMPLE_SECONDS):
    wait_for_start(cap, prompt)
    samples = []
    start = time.time()

    while time.time() - start < seconds:
        ret, frame = cap.read()
        if not ret:
            continue

        frame = cv2.flip(frame, 1)
        features = detect_features(landmarker, frame)
        if features is not None:
            samples.append(features["angleDeg"])
            remember_classifier_sample("neutral", features)

        remaining = max(0.0, seconds - (time.time() - start))
        overlay(frame, prompt, remaining, len(samples))
        cv2.imshow(WINDOW_NAME, frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            raise KeyboardInterrupt

    if len(samples) < 10:
        raise RuntimeError(f"Not enough hand samples for: {prompt}")

    median = statistics.median(samples)
    print(f"[Training] {prompt}: {median:.1f} deg from {len(samples)} samples")
    return median


def make_session_dir():
    session_name = time.strftime("session_%Y%m%d_%H%M%S")
    session_dir = DATASET_DIR / session_name
    (session_dir / "rotate_cw").mkdir(parents=True, exist_ok=True)
    (session_dir / "rotate_ccw").mkdir(parents=True, exist_ok=True)
    (session_dir / "soft_drop_wave_down").mkdir(parents=True, exist_ok=True)
    return session_dir


def clear_previous_training_images():
    DATASET_DIR.mkdir(parents=True, exist_ok=True)
    for child in DATASET_DIR.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    print(f"[Training] Cleared previous image datasets from: {DATASET_DIR}")


def capture_motion_dataset(cap, landmarker, prompt, class_name, session_dir, target_count=ROTATION_IMAGES_PER_MOTION):
    wait_for_start(cap, f"{prompt} - save {target_count} images")

    class_dir = session_dir / class_name
    class_dir.mkdir(parents=True, exist_ok=True)
    csv_path = session_dir / "labels.csv"
    write_header = not csv_path.exists()

    angles = []
    saved = 0
    last_save = 0.0
    min_save_gap = 1 / 24

    with csv_path.open("a", newline="", encoding="utf-8") as labels_file:
        writer = csv.writer(labels_file)
        if write_header:
            writer.writerow(["class_name", "image_path", "angle_deg", "palm_y"])

        while saved < target_count:
            ret, frame = cap.read()
            if not ret:
                continue

            frame = cv2.flip(frame, 1)
            clean_frame = frame.copy()
            features = detect_features(landmarker, frame)

            now = time.time()
            if features is not None and now - last_save >= min_save_gap:
                image_name = f"{class_name}_{saved + 1:04d}.jpg"
                image_path = class_dir / image_name
                cv2.imwrite(str(image_path), clean_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
                writer.writerow([
                    class_name,
                    str(image_path.relative_to(ROOT_DIR)),
                    round(features["angleDeg"], 4),
                    round(features["palmY"], 4),
                ])
                labels_file.flush()
                angles.append(features["angleDeg"])
                remember_classifier_sample(class_name, features)
                saved += 1
                last_save = now

            overlay(frame, prompt, samples_count=saved, target_count=target_count)
            cv2.imshow(WINDOW_NAME, frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                raise KeyboardInterrupt

    median = statistics.median(angles)
    print(f"[Training] {class_name}: saved {saved} images, median {median:.1f} deg")
    return {
        "className": class_name,
        "imageCount": saved,
        "imageDir": str(class_dir.relative_to(ROOT_DIR)),
        "medianAngleDeg": median,
    }


def capture_soft_drop_dataset(cap, landmarker, session_dir, target_count=SOFT_DROP_IMAGES):
    prompt = "Flat hand: wave DOWN to make the piece move faster"
    wait_for_start(cap, f"{prompt} - save {target_count} images")

    class_name = "soft_drop_wave_down"
    class_dir = session_dir / class_name
    class_dir.mkdir(parents=True, exist_ok=True)
    csv_path = session_dir / "labels.csv"
    write_header = not csv_path.exists()

    samples = []
    saved = 0
    last_save = 0.0
    min_save_gap = 1 / 24

    with csv_path.open("a", newline="", encoding="utf-8") as labels_file:
        writer = csv.writer(labels_file)
        if write_header:
            writer.writerow(["class_name", "image_path", "angle_deg", "palm_y"])

        while saved < target_count:
            ret, frame = cap.read()
            if not ret:
                continue

            frame = cv2.flip(frame, 1)
            clean_frame = frame.copy()
            features = detect_features(landmarker, frame)

            now = time.time()
            if features is not None and now - last_save >= min_save_gap:
                image_name = f"{class_name}_{saved + 1:04d}.jpg"
                image_path = class_dir / image_name
                cv2.imwrite(str(image_path), clean_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
                writer.writerow([
                    class_name,
                    str(image_path.relative_to(ROOT_DIR)),
                    round(features["angleDeg"], 4),
                    round(features["palmY"], 4),
                ])
                labels_file.flush()
                samples.append(features)
                remember_classifier_sample(class_name, features)
                saved += 1
                last_save = now

            overlay(frame, prompt, samples_count=saved, target_count=target_count)
            cv2.imshow(WINDOW_NAME, frame)

            if cv2.waitKey(1) & 0xFF == ord("q"):
                raise KeyboardInterrupt

    threshold = calculate_soft_drop_threshold(samples)
    print(f"[Training] {class_name}: saved {saved} images, threshold {threshold:.3f}")
    return {
        "className": class_name,
        "imageCount": saved,
        "imageDir": str(class_dir.relative_to(ROOT_DIR)),
        "waveDownThreshold": threshold,
        "medianPalmY": statistics.median(sample["palmY"] for sample in samples),
    }


def calculate_soft_drop_threshold(samples):
    if len(samples) < 12:
        raise RuntimeError("Not enough soft-drop samples to train down-wave movement.")

    window = 4
    deltas = []
    for index in range(window, len(samples)):
        dy = samples[index]["palmY"] - samples[index - window]["palmY"]
        if dy > 0:
            deltas.append(dy)

    if not deltas:
        raise RuntimeError("No downward palm movement detected. Try the soft-drop training again.")

    median_down = statistics.median(deltas)
    return max(0.035, min(0.18, round(median_down * 0.65, 3)))


def load_existing_training():
    if not OUTPUT_JS.exists():
        return {}

    text = OUTPUT_JS.read_text(encoding="utf-8")
    match = re.search(r"window\.TETRIS_HANDS_GESTURE_TRAINING\s*=\s*(\{.*?\});", text, re.S)
    if not match:
        return {}

    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}


def build_rotation_training(cw_delta, ccw_delta, rotation_is_strong, existing_training):
    return DEFAULT_ROTATION_TRAINING.copy(), "trained_pinch_rotation"


def build_soft_drop_training(soft_drop_dataset):
    return {
        "gesture": "trained_flat_hand_wave_down",
        "waveDownThreshold": soft_drop_dataset["waveDownThreshold"],
        "waveWindowMs": 180,
        "repeatMs": 80,
        "holdMs": 650,
        "requireOpenPalm": True,
    }


def save_training_files(training):
    OUTPUT_JSON.write_text(json.dumps(training, indent=2), encoding="utf-8")
    OUTPUT_JS.write_text(
        "(function () {\n"
        "  \"use strict\";\n\n"
        "  window.TETRIS_HANDS_GESTURE_TRAINING = "
        + json.dumps(training, indent=2)
        + ";\n"
        "})();\n",
        encoding="utf-8",
    )
    OUTPUT_SAMPLES_JS.write_text(
        "(function () {\n"
        "  \"use strict\";\n\n"
        "  window.TETRIS_GESTURE_SAMPLES = "
        + json.dumps({
            "featureCount": 63,
            "samples": classifier_samples,
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        }, indent=2)
        + ";\n"
        "})();\n",
        encoding="utf-8",
    )


def write_training(cw_delta, ccw_delta, session_dir, cw_dataset, ccw_dataset, soft_drop_dataset, rotation_is_strong):
    existing_training = load_existing_training()
    rotation_training, rotation_status = build_rotation_training(
        cw_delta,
        ccw_delta,
        rotation_is_strong,
        existing_training,
    )

    training = {
        "rotation": rotation_training,
        "softDrop": build_soft_drop_training(soft_drop_dataset),
        "trainingMeta": {
            "cwDeltaDeg": round(cw_delta, 2),
            "ccwDeltaDeg": round(ccw_delta, 2),
            "rotationStatus": rotation_status,
            "imagesPerMotion": ROTATION_IMAGES_PER_MOTION,
            "softDropImages": SOFT_DROP_IMAGES,
            "datasetDir": str(session_dir.relative_to(ROOT_DIR)),
            "classes": {
                "rotate_cw": {
                    "imageCount": cw_dataset["imageCount"],
                    "imageDir": cw_dataset["imageDir"],
                    "medianAngleDeg": round(cw_dataset["medianAngleDeg"], 2),
                },
                "rotate_ccw": {
                    "imageCount": ccw_dataset["imageCount"],
                    "imageDir": ccw_dataset["imageDir"],
                    "medianAngleDeg": round(ccw_dataset["medianAngleDeg"], 2),
                },
                "soft_drop_wave_down": {
                    "imageCount": soft_drop_dataset["imageCount"],
                    "imageDir": soft_drop_dataset["imageDir"],
                    "waveDownThreshold": soft_drop_dataset["waveDownThreshold"],
                    "medianPalmY": round(soft_drop_dataset["medianPalmY"], 4),
                },
            },
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
    }

    save_training_files(training)

    print(f"\n[Training] Saved app settings to: {OUTPUT_JS}")
    print(f"[Training] Saved readable copy to: {OUTPUT_JSON}")
    print(f"[Training] Saved image dataset to: {session_dir}")
    print(
        "[Training] Rotate trigger: "
        f"{rotation_training['triggerDeg']} deg, release: {rotation_training['releaseDeg']} deg, "
        f"cwDirection: {rotation_training['cwDirection']}"
    )
    print(f"[Training] Rotation status: {rotation_status}")
    print(f"[Training] Soft-drop wave threshold: {soft_drop_dataset['waveDownThreshold']}")


def write_soft_drop_only(session_dir, soft_drop_dataset):
    existing_training = load_existing_training()
    training = {
        "rotation": existing_training.get("rotation", DEFAULT_ROTATION_TRAINING.copy()),
        "softDrop": build_soft_drop_training(soft_drop_dataset),
        "trainingMeta": {
            "rotationStatus": "kept_previous_rotation",
            "softDropImages": SOFT_DROP_IMAGES,
            "datasetDir": str(session_dir.relative_to(ROOT_DIR)),
            "classes": {
                "soft_drop_wave_down": {
                    "imageCount": soft_drop_dataset["imageCount"],
                    "imageDir": soft_drop_dataset["imageDir"],
                    "waveDownThreshold": soft_drop_dataset["waveDownThreshold"],
                    "medianPalmY": round(soft_drop_dataset["medianPalmY"], 4),
                },
            },
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
    }
    save_training_files(training)
    print(f"\n[Training] Saved soft-drop settings to: {OUTPUT_JS}")
    print(f"[Training] Saved readable copy to: {OUTPUT_JSON}")
    print(f"[Training] Saved image dataset to: {session_dir}")
    print(f"[Training] Soft-drop wave threshold: {soft_drop_dataset['waveDownThreshold']}")


def write_rotation_only(cw_delta, ccw_delta, session_dir, cw_dataset, ccw_dataset, rotation_is_strong):
    existing_training = load_existing_training()
    rotation_training, rotation_status = build_rotation_training(
        cw_delta,
        ccw_delta,
        rotation_is_strong,
        existing_training,
    )
    training = {
        "rotation": rotation_training,
        "softDrop": existing_training.get("softDrop", DEFAULT_SOFT_DROP_TRAINING.copy()),
        "trainingMeta": {
            "cwDeltaDeg": round(cw_delta, 2),
            "ccwDeltaDeg": round(ccw_delta, 2),
            "rotationStatus": rotation_status,
            "imagesPerMotion": ROTATION_IMAGES_PER_MOTION,
            "datasetDir": str(session_dir.relative_to(ROOT_DIR)),
            "classes": {
                "rotate_cw": {
                    "imageCount": cw_dataset["imageCount"],
                    "imageDir": cw_dataset["imageDir"],
                    "medianAngleDeg": round(cw_dataset["medianAngleDeg"], 2),
                },
                "rotate_ccw": {
                    "imageCount": ccw_dataset["imageCount"],
                    "imageDir": ccw_dataset["imageDir"],
                    "medianAngleDeg": round(ccw_dataset["medianAngleDeg"], 2),
                },
            },
            "createdAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        },
    }
    save_training_files(training)
    print(f"\n[Training] Saved rotation settings to: {OUTPUT_JS}")
    print(f"[Training] Saved readable copy to: {OUTPUT_JSON}")
    print(f"[Training] Saved image dataset to: {session_dir}")
    print(
        "[Training] Rotate trigger: "
        f"{rotation_training['triggerDeg']} deg, release: {rotation_training['releaseDeg']} deg, "
        f"cwDirection: {rotation_training['cwDirection']}"
    )
    print(f"[Training] Rotation status: {rotation_status}")


def main():
    args = parse_args()
    print("Tetris Hands gesture training")
    print(f"Mode: {args.mode}")
    if args.mode in ("all", "rotation"):
        print(f"It will capture {ROTATION_IMAGES_PER_MOTION} images for thumb+index rotate CW and {ROTATION_IMAGES_PER_MOTION} images for thumb+middle rotate CCW.")
    if args.mode in ("all", "soft-drop"):
        print(f"It will capture {SOFT_DROP_IMAGES} images for flat-hand wave-down soft drop.")

    cap = open_camera()
    landmarker = create_landmarker()

    try:
        clear_previous_training_images()
        session_dir = make_session_dir()

        cw_delta = None
        ccw_delta = None
        cw_dataset = None
        ccw_dataset = None
        rotation_is_strong = False

        if args.mode in ("all", "rotation"):
            neutral = capture_stage(cap, landmarker, "Hold your hand neutral / relaxed")
            cw_dataset = capture_motion_dataset(
                cap,
                landmarker,
                "Thumb + index pinch for CLOCKWISE rotate",
                "rotate_cw",
                session_dir,
            )
            ccw_dataset = capture_motion_dataset(
                cap,
                landmarker,
                "Thumb + middle pinch for COUNTER-CLOCKWISE rotate",
                "rotate_ccw",
                session_dir,
            )
            cw_delta = wrap_deg(cw_dataset["medianAngleDeg"] - neutral)
            ccw_delta = wrap_deg(ccw_dataset["medianAngleDeg"] - neutral)
            rotation_is_strong = True

        if args.mode == "all":
            soft_drop_dataset = capture_soft_drop_dataset(cap, landmarker, session_dir)
            write_training(
                cw_delta,
                ccw_delta,
                session_dir,
                cw_dataset,
                ccw_dataset,
                soft_drop_dataset,
                rotation_is_strong,
            )
        elif args.mode == "rotation":
            write_rotation_only(cw_delta, ccw_delta, session_dir, cw_dataset, ccw_dataset, rotation_is_strong)
        else:
            soft_drop_dataset = capture_soft_drop_dataset(cap, landmarker, session_dir)
            write_soft_drop_only(session_dir, soft_drop_dataset)
    except KeyboardInterrupt:
        print("\n[Training] Cancelled")
    finally:
        cap.release()
        cv2.destroyAllWindows()
        landmarker.close()


if __name__ == "__main__":
    main()
