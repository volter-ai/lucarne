FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Just an isolated Chrome with CDP reachable. The engine drives view + record
# over CDP (no in-container noVNC / GStreamer / VNC stack needed).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      socat \
      x11-utils \
      xvfb \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 9222
CMD ["/usr/local/bin/start.sh"]
