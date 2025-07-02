#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# generate_video.sh – Convert a ZIP of PNG frames (exported by Particle-Lenia)
#                     into three shareable formats:
#                       1) MP4 (H.264)
#                       2) WebM (loss-less VP9)
#                       3) GIF  (small preview)
# -----------------------------------------------------------------------------
# Usage:
#   ./generate_video.sh my-simulation.zip [fps]
#
#   fps – optional; defaults to 60 if not provided.
# -----------------------------------------------------------------------------
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <zip-file> [fps]" >&2
  exit 1
fi

ZIP_FILE="$1"
FPS="${2:-60}"

if [[ ! -f "$ZIP_FILE" ]]; then
  echo "Error: '$ZIP_FILE' not found" >&2
  exit 1
fi

# Derive base name (strip extension)
BASE_NAME="${ZIP_FILE%.*}"

# Create a temporary directory for the extracted frames
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ------------------------------------------------------
# 1. Extract PNG sequence
# ------------------------------------------------------
unzip -q "$ZIP_FILE" -d "$TMP_DIR"

# Verify that frames exist
if ! ls "$TMP_DIR"/frame_*.png >/dev/null 2>&1; then
  echo "Error: No frames found in ZIP (expected names like frame_00000.png)" >&2
  exit 1
fi

# ------------------------------------------------------
# 2. Render MP4 (H.264)
# ------------------------------------------------------
ffmpeg -y -loglevel warning \
       -framerate "$FPS" \
       -i "$TMP_DIR/frame_%05d.png" \
       -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
       "${BASE_NAME}.mp4"

echo "✅ Wrote ${BASE_NAME}.mp4"

# ------------------------------------------------------
# 3. Render WebM (loss-less VP9)
# ------------------------------------------------------
ffmpeg -y -loglevel warning \
       -framerate "$FPS" \
       -i "$TMP_DIR/frame_%05d.png" \
       -c:v libvpx-vp9 -lossless 1 -row-mt 1 \
       "${BASE_NAME}.webm"

echo "✅ Wrote ${BASE_NAME}.webm"

# ------------------------------------------------------
# 4. Render GIF preview (scaled to width 640, 30 fps)
# ------------------------------------------------------
ffmpeg -y -loglevel warning \
       -framerate 30 \
       -i "$TMP_DIR/frame_%05d.png" \
       -vf "scale=640:-1:flags=lanczos" -loop 0 \
       "${BASE_NAME}.gif"

echo "✅ Wrote ${BASE_NAME}.gif"

# Cleanup handled by trap 