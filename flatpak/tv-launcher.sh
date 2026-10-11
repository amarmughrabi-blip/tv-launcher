#!/bin/sh
exec /app/lib/tv-launcher/vendor/ecs-dist/electron --no-sandbox --disable-gpu-sandbox /app/lib/tv-launcher/main.js "$@"
