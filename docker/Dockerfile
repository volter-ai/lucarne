FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Chrome + virtual display + VNC/noVNC + recorder + CDP bridge.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      fluxbox \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-ugly \
      gstreamer1.0-tools \
      gstreamer1.0-x \
      novnc \
      socat \
      websockify \
      x11-utils \
      x11vnc \
      xvfb \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

# noVNC (8080) + CDP (9222)
EXPOSE 8080 9222

CMD ["/usr/local/bin/start.sh"]
