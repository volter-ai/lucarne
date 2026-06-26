#!/usr/bin/env bash
# One container, one isolated Chrome, four cooperating processes:
#   Xvfb         -> a fake :99 display nothing else can see
#   chromium     -> headful, on :99, CDP on localhost:9223
#   socat        -> bridges 0.0.0.0:9222 -> 127.0.0.1:9223 so the host can drive CDP
#   x11vnc+novnc -> the porthole: see + use the browser at /vnc.html
#   recorder     -> CCTV ring: 1-min segments, oldest pruned past RETENTION_MIN
set -euo pipefail

DISPLAY_NUM=":99"
RES="${RES:-1280x720}"
FPS="${FPS:-15}"
FLOOR_FPS="${FLOOR_FPS:-4}"
RETENTION_MIN="${REC_RETENTION_MIN:-60}"
export DISPLAY="$DISPLAY_NUM"

mkdir -p /rec /profile
rm -f /tmp/.X99-lock
# A persisted profile keeps chromium's Singleton* locks (host+pid). On container
# recreation the hostname changes, so chromium reads them as "in use by another
# computer" and refuses to start. Nothing else holds the profile at boot.
rm -f /profile/Singleton* 2>/dev/null || true

echo "[lucarne] Xvfb on $DISPLAY_NUM ($RES)"
Xvfb "$DISPLAY_NUM" -screen 0 "${RES}x24" -ac -nolisten tcp &
for _ in $(seq 1 50); do xdpyinfo -display "$DISPLAY_NUM" >/dev/null 2>&1 && break; sleep 0.2; done

fluxbox >/dev/null 2>&1 &

echo "[lucarne] chromium (CDP on 127.0.0.1:9223)"
chromium \
  --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --user-data-dir=/profile \
  --remote-debugging-port=9223 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  --no-first-run --no-default-browser-check \
  --window-position=0,0 --window-size=${RES/x/,} \
  --start-maximized \
  about:blank &

echo "[lucarne] socat CDP bridge 0.0.0.0:9222 -> 127.0.0.1:9223"
socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223 &

echo "[lucarne] x11vnc + noVNC on :8080"
x11vnc -display "$DISPLAY_NUM" -nopw -forever -shared -rfbport 5900 -quiet &
websockify --web=/usr/share/novnc 8080 localhost:5900 >/dev/null 2>&1 &

echo "[lucarne] prune loop: keep last ${RETENTION_MIN} min"
( while true; do
    find /rec -maxdepth 1 -name 'seg_*.mp4' -mmin +"${RETENTION_MIN}" -delete 2>/dev/null || true
    sleep 30
  done ) &

RECORDER="${RECORDER:-gst}"
if [ "$RECORDER" = "ffmpeg" ]; then
  echo "[lucarne] ffmpeg ring recorder (blind grab)"
  exec ffmpeg -loglevel warning -nostdin \
    -f x11grab -framerate "$FPS" -video_size "$RES" -i "$DISPLAY_NUM" \
    -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -crf 28 -g $((FPS*2)) \
    -f segment -segment_time 60 -segment_atclocktime 1 -strftime 1 -reset_timestamps 1 \
    /rec/seg_%Y%m%d_%H%M%S.mp4
fi

# Efficient default: XDamage-driven capture (XShm — do NOT set remote=true, it
# disables XShm and ~doubles CPU) capped at a low frame floor so segments still
# cut every 60s, with the ultrafast x264 preset.
echo "[lucarne] gstreamer ring recorder (XDamage + ${FLOOR_FPS}fps floor, ultrafast)"
exec gst-launch-1.0 -e \
  ximagesrc display-name="$DISPLAY_NUM" use-damage=true show-pointer=true \
    ! video/x-raw,framerate="${FLOOR_FPS}/1" \
    ! videoconvert ! videorate ! video/x-raw,framerate="${FLOOR_FPS}/1" \
    ! queue ! x264enc speed-preset=ultrafast tune=zerolatency key-int-max=$((FLOOR_FPS*2)) bitrate=1500 \
    ! h264parse \
    ! splitmuxsink muxer-factory=mp4mux max-size-time=60000000000 location=/rec/seg_%05d.mp4
