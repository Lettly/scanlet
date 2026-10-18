# Scanlet Bridge, as a Home Assistant add-on.
#
# The app and the bridge are fetched from a pinned ref rather than copied in, so
# this folder stays small and the image is reproducible.
ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

ARG SCANLET_REF=main

# Docker caches this layer on the arguments it can see, so a download whose only
# argument never changes keeps the *previous* app forever, however often the image
# is rebuilt — which is how a rebuild can silently ship last week's code. Bump
# this with `version:` in config.yaml; scanlet_bridge/test/addon.test.mjs fails
# the suite if the two drift apart.
ARG SCANLET_BUILD=1.1.1

RUN apk add --no-cache ca-certificates curl tar \
 && mkdir -p /app \
 && echo "app ref ${SCANLET_REF}, add-on build ${SCANLET_BUILD}" > /app/.scanlet-build \
 && curl -fsSL "https://github.com/Lettly/scanlet/archive/${SCANLET_REF}.tar.gz" -o /tmp/scanlet.tgz \
 && tar -xzf /tmp/scanlet.tgz --strip-components=1 -C /app \
 && rm -f /tmp/scanlet.tgz \
 && test -f /app/index.html \
 && test -f /app/bridge/scanlet-bridge.mjs \
 && test -d /app/vendor

COPY run.mjs /addon/run.mjs

WORKDIR /addon
CMD ["node", "/addon/run.mjs"]
