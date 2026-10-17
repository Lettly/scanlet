# Scanlet Bridge, as a Home Assistant add-on.
#
# The app and the bridge are fetched from a pinned ref rather than copied in, so
# this folder stays small and the image is reproducible. Bump SCANLET_REF with
# the add-on version to ship a newer app.
ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

ARG SCANLET_REF=main

RUN apk add --no-cache ca-certificates curl tar \
 && mkdir -p /app \
 && curl -fsSL "https://github.com/Lettly/scanlet/archive/${SCANLET_REF}.tar.gz" -o /tmp/scanlet.tgz \
 && tar -xzf /tmp/scanlet.tgz --strip-components=1 -C /app \
 && rm -f /tmp/scanlet.tgz \
 && test -f /app/index.html \
 && test -f /app/bridge/scanlet-bridge.mjs \
 && test -d /app/vendor

COPY run.mjs /addon/run.mjs

WORKDIR /addon
CMD ["node", "/addon/run.mjs"]
