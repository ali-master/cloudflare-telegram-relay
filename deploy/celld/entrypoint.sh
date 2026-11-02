#!/bin/sh
set -eu

command=${1:-serve}
if [ "$#" -gt 0 ]; then shift; fi

# Compose includes optional values as empty strings. Let celld's credential and
# endpoint discovery handle omitted values rather than treating them as values.
for variable in S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [ -z "$(printenv "$variable" 2>/dev/null || true)" ]; then unset "$variable"; fi
done

if { [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; } \
  || { [ -z "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]; }; then
  printf '%s\n' 'Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or omit both to use the runtime credential chain.' >&2
  exit 64
fi

case "$command" in
  publish)
    : "${CELLD_BUCKET:?Set CELLD_BUCKET to the fleet bucket and optional prefix}"
    exec node /app/deploy/celld/publish.mjs "$@"
    ;;
  serve)
    : "${CELLD_BUCKET:?Set CELLD_BUCKET to the fleet bucket and optional prefix}"
    export CELLD_STATE_DIR="${CELLD_STATE_DIR:-/var/lib/celld}"
    mkdir -p "$CELLD_STATE_DIR"
    # celld uses this directory for the node's SQLite state and replication files.
    unset CELLD_TEST_DATA_DIR
    export CELLD_WATCH="$CELLD_STATE_DIR"
    export CELLD_ADDR="${CELLD_ADDR:-0.0.0.0:8080}"
    export CELLD_INTERNAL_ADDR="${CELLD_INTERNAL_ADDR:-0.0.0.0:8081}"
    export CELLD_ADVERTISE="${CELLD_ADVERTISE:-$(hostname):8081}"
    exec celld "$@"
    ;;
  diagnose)
    : "${CELLD_BUCKET:?Set CELLD_BUCKET to the fleet bucket and optional prefix}"
    exec celld diagnose "$@"
    ;;
  version)
    exec celld --version
    ;;
  *)
    printf '%s\n' 'Usage: entrypoint.sh publish|serve|diagnose|version [celld options]' >&2
    exit 64
    ;;
esac
