#!/bin/sh
set -eu

# Publish the same release before updating the runtime, in an explicit cluster.
if [ "$#" -ne 4 ] || [ ! -f "$1" ] || [ ! -d "$4" ]; then
  echo 'Usage: deploy.sh /absolute/kubeconfig CONTEXT NAMESPACE OVERLAY_DIRECTORY' >&2
  exit 64
fi
case "$1" in
  /*) ;;
  *) echo 'Use an absolute kubeconfig path.' >&2; exit 64 ;;
esac
kubeconfig=$1
context=$2
namespace=$3
overlay=$4
if [ -z "$context" ] || [ -z "$namespace" ]; then
  echo 'An explicit context and namespace are required.' >&2
  exit 64
fi
kube() {
  kubectl --kubeconfig "$kubeconfig" --context "$context" \
    --namespace "$namespace" --request-timeout=30s "$@"
}

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/relay-celld-deploy.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
kubectl kustomize "$overlay" > "$work/release.yaml"
case "$(cat "$work/release.yaml")" in
  *CHANGE_ME*|*replace-me*|*registry.example.com*|*s3.example.invalid*)
    echo 'Edit the overlay image, bucket and storage settings before deploying.' >&2
    exit 64
    ;;
esac

# Inspect every rendered object before the first mutation. Explicit YAML
# namespaces must match the requested target, not merely kubectl's default.
kube create --dry-run=client -f "$work/release.yaml" \
  -o 'jsonpath={.kind}{"|"}{.metadata.name}{"|"}{.metadata.namespace}{"|"}{.metadata.labels.relay-deploy-phase}{"|"}{.spec.template.spec.containers[0].image}{"|"}{.spec.replicas}{"\n"}' \
  > "$work/resources.txt"
count=0
seen='|'
publish_image=
runtime_image=
while IFS='|' read -r kind name resource_namespace phase image replicas; do
  if [ "$resource_namespace" != "$namespace" ]; then
    echo "Rendered $kind/$name does not target namespace $namespace." >&2
    exit 64
  fi
  key="$kind/$name"
  case "$seen" in
    *"|$key|"*) echo "Duplicate rendered resource: $key" >&2; exit 64 ;;
  esac
  seen="$seen$key|"
  case "$key:$phase" in
    ConfigMap/relay-celld-config:configuration|Service/relay-celld:configuration|Service/relay-celld-peers:configuration|NetworkPolicy/relay-celld-ingress:configuration) ;;
    Job/relay-celld-publish:publish) publish_image=$image ;;
    StatefulSet/relay-celld:runtime)
      runtime_image=$image
      if [ "$replicas" != 1 ]; then
        echo 'This deployment layout requires exactly one runtime replica.' >&2
        exit 64
      fi
      ;;
    *) echo "Unexpected deployment resource or phase: $key ($phase)" >&2; exit 64 ;;
  esac
  count=$((count + 1))
done < "$work/resources.txt"
if [ "$count" -ne 6 ] || [ -z "$publish_image" ] || [ "$publish_image" != "$runtime_image" ]; then
  echo 'Expected six base resources with the same publisher and runtime image.' >&2
  exit 64
fi

printf 'Deploying Telegram Relay to context %s, namespace %s.\n' "$context" "$namespace"
kube get namespace "$namespace" >/dev/null
kube get secret relay-celld-storage relay-celld-admin >/dev/null
# Validate config/runtime before changing resources. The existing completed Job
# has an immutable template, so its replacement is handled separately below.
kube apply --dry-run=server -f "$work/release.yaml" \
  --selector=relay-deploy-phase=configuration >/dev/null
kube apply --dry-run=server -f "$work/release.yaml" \
  --selector=relay-deploy-phase=runtime >/dev/null
kube create --dry-run=client -f "$work/release.yaml" \
  --selector=relay-deploy-phase=runtime -o yaml > "$work/runtime.yaml"
# A single Pod-template update applies the image and fresh ConfigMap/Secrets.
# This also reloads configuration when the image reference has not changed.
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
kube patch --local -f "$work/runtime.yaml" --type=merge \
  -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"relay.celld.dev/deployed-at\":\"$stamp\"}}}}}" \
  -o yaml > "$work/runtime-release.yaml"

kube apply -f "$work/release.yaml" --selector=relay-deploy-phase=configuration
kube delete job relay-celld-publish --ignore-not-found --wait=true --timeout=90s
kube apply -f "$work/release.yaml" --selector=relay-deploy-phase=publish
if ! kube wait --for=condition=complete job/relay-celld-publish --timeout=600s; then
  echo 'Publishing failed or timed out; the serving StatefulSet was not updated.' >&2
  echo 'Inspect relay-celld-publish logs in the explicit context before retrying.' >&2
  exit 1
fi
kube apply -f "$work/runtime-release.yaml"
kube rollout status statefulset/relay-celld --timeout=360s
