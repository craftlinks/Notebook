#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# generate_video.sh – Convert a ZIP of PNG frames (exported by Particle-Lenia)
#                     into three shareable formats:
#                       1) MP4 (H.264)
#                       2) WebM (loss-less VP9)
#                       3) GIF  (small preview)
# -----------------------------------------------------------------------------
# Usage:
#   ./generate_video.sh <zip-or-glob> [<zip-or-glob> ...] [fps]
#
#   Provide one or more ZIP files containing PNG frames named
#   frame_00000.png, frame_00001.png, … (the format exported by
#   Particle-Lenia).  The last argument may be a plain integer which – if
#   present – is interpreted as the desired frame-rate.  When multiple ZIP
#   parts are given they are extracted into a single temporary directory in
#   the order provided so the resulting video is continuous.
#
#   fps – optional; defaults to 60 if not provided.
# -----------------------------------------------------------------------------
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <zip-or-glob>… [fps]" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Parse arguments – detect FPS if last param is a plain integer
# -----------------------------------------------------------------------------

args=("$@")

# Default FPS
FPS=60

# Check if last argument is a number => treat as FPS
last_index=$((${#args[@]} - 1))
if [[ ${args[$last_index]} =~ ^[0-9]+$ ]]; then
  FPS="${args[$last_index]}"
  unset 'args[$last_index]'
fi

if [[ ${#args[@]} -eq 0 ]]; then
  echo "Error: No ZIP files provided" >&2
  exit 1
fi

ZIP_FILES=("${args[@]}")

# Verify that each zip exists
for z in "${ZIP_FILES[@]}"; do
  if [[ ! -f "$z" ]]; then
    echo "Error: '$z' not found" >&2
    exit 1
  fi
done

# Derive base name from first ZIP (strip _partNN and extension)
BASE_NAME="${ZIP_FILES[0]%.*}"
BASE_NAME="${BASE_NAME%_part*}"

# Create (or reuse) a local temporary directory for the extracted frames
# Using a fixed path makes debugging easier because you can inspect the extracted
# PNG sequence after the script completes. The directory is still cleaned up at
# exit to avoid clutter.
TMP_DIR="./tmp"

# Ensure a clean directory each run
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# Remove the directory on script exit (comment the next line out if you would
# like to keep the extracted frames)
trap 'rm -rf "$TMP_DIR"' EXIT

# ------------------------------------------------------
# 1. Extract PNG sequence
# ------------------------------------------------------
# Extract frames from all ZIPs (keep order)
for z in "${ZIP_FILES[@]}"; do
  echo "📦 Extracting $(basename "$z")"
  unzip -q -n "$z" -d "$TMP_DIR"
done

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