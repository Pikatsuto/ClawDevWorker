###############################################################################
# browserless — Headless Chromium + nodriver + FastAPI
#
# Base: python:3.12-alpine
###############################################################################

FROM python:3.12-alpine

RUN apk add --no-cache \
        chromium \
        chromium-chromedriver \
        xvfb-run \
        font-noto \
        dbus \
        mesa-dri-gallium

RUN pip install --no-cache-dir nodriver fastapi uvicorn

WORKDIR /opt/browserless
COPY services/browserless/server.py .
COPY --chmod=755 services/browserless/entrypoint.sh /usr/local/bin/entrypoint

ENV CHROME_PATH=/usr/bin/chromium-browser
ENV DISPLAY=:99
ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["entrypoint"]