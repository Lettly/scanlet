# Scanlet Bridge, as a Home Assistant add-on.
#
# The app and the bridge are fetched from a pinned ref rather than copied in, so
# this folder stays small and the image is reproducible.
#
# Debian rather than Alpine, so SANE can be installed: `scanimage` lets the
# bridge drive a scanner that has only a Linux driver (a Samsung M2070, say),
# not just a driverless eSCL/AirScan one. `sane-airscan` covers the driverless
# kind. A vendor driver is not redistributable, so it is the operator's to add
# (mount it in and point SANE at it) — see README.md.
ARG BUILD_FROM=debian:bookworm-slim
FROM ${BUILD_FROM}

ARG SCANLET_REF=main

# Docker caches this layer on the arguments it can see, so a download whose only
# argument never changes keeps the *previous* app forever, however often the image
# is rebuilt — which is how a rebuild can silently ship last week's code. Bump
# this with `version:` in config.yaml; scanlet_bridge/test/addon.test.mjs fails
# the suite if the two drift apart.
ARG SCANLET_BUILD=1.2.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tar nodejs sane-utils sane-airscan \
 && rm -rf /var/lib/apt/lists/* \
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
