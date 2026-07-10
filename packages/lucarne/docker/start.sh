#!/usr/bin/env bash
# Isolated Chrome on a virtual display, with CDP bridged out on :9222.
# That's all the container does — the lucarne engine drives view + record over CDP.
set -euo pipefail

export DISPLAY=":99"
RES="${RES:-1280x720}"

mkdir -p /profile
rm -f /tmp/.X99-lock
# stale Singleton* locks (host+pid) from a previous container block startup
rm -f /profile/Singleton* 2>/dev/null || true

Xvfb ":99" -screen 0 "${RES}x24" -ac -nolisten tcp &
for _ in $(seq 1 50); do xdpyinfo -display ":99" >/dev/null 2>&1 && break; sleep 0.2; done

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

# bridge CDP to 0.0.0.0:9222 so the engine can reach it (foreground = keeps container alive)
exec socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223
