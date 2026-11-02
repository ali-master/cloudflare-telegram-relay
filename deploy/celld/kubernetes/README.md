# Deploy with Kubernetes

For a sanitized illustration of the Argo CD deployment pattern, see the
[Argo CD overlay example](overlays/argocd-example/README.md). It contains no
live environment values and is not connected to an Argo CD Application.

These manifests run the existing Telegram Relay on celld with a persistent state
volume and an external S3-compatible bucket. The application image uses the real
Telegram API. No test server, local cluster, or storage emulator is installed.

Use one runtime replica. A release is published to the bucket first, then the
StatefulSet is started or updated. The same image reference is used for both
steps. This layout is not a validated multi-node high-availability deployment.

## Requirements

- A Kubernetes cluster, `kubectl` with Kustomize support, and a persistent storage
  class that supports `ReadWriteOnce` volumes.
- A pre-created private bucket and bucket-scoped credentials. Check the
  [celld storage requirements](https://github.com/denoland/celld/blob/v0.6.3/docs/guarantees.md)
  for your provider; S3 API compatibility alone is insufficient.
- The [application image](../README.md) built and pushed to a registry reachable
  by the cluster. Use an immutable tag, preferably an image digest.
- Public HTTPS for Telegram webhooks. The optional gateway below terminates TLS;
  an existing ingress can be used when it implements the same header contract.

Run the repository commands from its root directory.

## 1. Select the target and configure the release

Use an explicit kubeconfig and context throughout:

```sh
export RELAY_KUBECONFIG=/absolute/path/to/kubeconfig
export RELAY_CONTEXT=your-context
export RELAY_NAMESPACE=telegram-relay

kube() {
  kubectl --kubeconfig "$RELAY_KUBECONFIG" --context "$RELAY_CONTEXT" \
    --namespace "$RELAY_NAMESPACE" "$@"
}

kube create namespace "$RELAY_NAMESPACE" --dry-run=client -o yaml | kube apply -f -
cp -R deploy/celld/kubernetes/overlays/deployment deploy/celld/kubernetes/overlays/local
```

Edit `overlays/local/kustomization.yaml`:

| Field | Set it to |
| --- | --- |
| `namespace` | The same namespace as `RELAY_NAMESPACE` |
| `images[].newName` and `newTag` | Your published application image; replace `newTag` with `digest` to pin a digest |
| `CELLD_BUCKET` | Your existing fleet bucket and prefix, such as `s3://relay-data/production` |
| `AWS_REGION` | Your bucket's region |
| `S3_ENDPOINT` | An HTTPS endpoint for compatible storage, or empty for AWS S3 |
| `CELLD_TRUST_FORWARDED_HEADERS` | Keep `"0"` for private direct access; use `"1"` only behind the trusted HTTPS gateway described below |
| `volumeClaimTemplates` | Your storage class and state-volume size |

For a private registry, add `imagePullSecrets` to both the publishing Job and the
StatefulSet in this overlay. Existing PVC templates cannot be edited freely:
plan storage-class changes or volume expansion separately from an application
release. The supplied example requests 10 GiB; size it for your workload.

## 2. Install secrets

Keep credentials outside the checkout. Create a file containing the admin key
and a separate environment file for storage credentials:

```sh
export RELAY_SECRETS_DIR="$HOME/.config/telegram-relay"
mkdir -p "$RELAY_SECRETS_DIR"
chmod 700 "$RELAY_SECRETS_DIR"
umask 077
openssl rand -hex 32 > "$RELAY_SECRETS_DIR/API_KEY"
```

Save the following keys with your actual values in
`$RELAY_SECRETS_DIR/storage.env`; add `AWS_SESSION_TOKEN` if your credentials need
it. Empty values are not usable credentials.

```dotenv
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
```

Create or update the two Secrets without placing values in command arguments:

```sh
kube create secret generic relay-celld-storage \
  --from-env-file="$RELAY_SECRETS_DIR/storage.env" \
  --dry-run=client -o yaml | kube apply -f -
kube create secret generic relay-celld-admin \
  --from-file=API_KEY="$RELAY_SECRETS_DIR/API_KEY" \
  --dry-run=client -o yaml | kube apply -f -
```

Only the publishing Job mounts the admin key. It becomes the Worker's `API_KEY`
binding in the fleet deployment. **The bucket and its backups contain that
binding and the bot tokens stored by the application.** Restrict access to the
fleet and its operators. Serving Pods need storage credentials but do not mount
the separate admin Secret.

## 3. Publish and start

Render the overlay before deployment:

```sh
kubectl kustomize deploy/celld/kubernetes/overlays/local > /tmp/telegram-relay.yaml
sh deploy/celld/kubernetes/deploy.sh \
  "$RELAY_KUBECONFIG" "$RELAY_CONTEXT" "$RELAY_NAMESPACE" \
  deploy/celld/kubernetes/overlays/local
```

The helper rejects unedited placeholders and never changes your current context.
It validates the resources, applies configuration/network resources, recreates
only `relay-celld-publish`, and waits for successful publication. Only then does
it apply the runtime with one Pod-template update. It never scales an existing
runtime to zero or deletes its PVC. A failed publication leaves the serving
StatefulSet unchanged, although the new ConfigMap has already been applied.
Do not run two release helpers concurrently against the same namespace/bucket.

The image, ConfigMap and Secret values are loaded together when the serving Pod
is replaced. This also handles configuration-only releases. Re-run this helper
after updating the overlay or either Secret; applying the entire overlay in one
command does not preserve the publication-before-runtime ordering. Keep the
`relay-deploy-phase` labels and the six base resource names. The helper validates
all rendered namespaces and the publisher/runtime image match; apply additional
infrastructure, such as the optional gateway, separately.

A successful publisher is not a health check. The helper separately waits up to
six minutes for the runtime rollout. Readiness checks celld's native
`/.well-known/celld/health`; startup allows five minutes. In local verification,
replacement sometimes needed about two minutes before becoming Ready.

For private dashboard access:

```sh
kube port-forward service/relay-celld 8080:8080
```

Open `http://127.0.0.1:8080` and log in with the generated admin key. This tunnel
is for trusted local access; Telegram cannot send webhooks to it.

## 4. Configure public HTTPS

The base exposes only ClusterIP Services. Port 8081 is celld's private,
unauthenticated operator/peer interface and must never be public. A NetworkPolicy
permits port 8080 only from this namespace's Pods labelled `relay-celld-client: "true"` and port
8081 only from this namespace's runtime Pods. Use a CNI that enforces this policy.

The optional [gateway example](gateway.example.yaml) runs an unprivileged nginx
TLS proxy on port 8443, exposed through a port-443 LoadBalancer Service. It
replaces forwarded host/protocol headers, uses the socket peer for
`CF-Connecting-IP`, removes `CF-Ray`, rejects unknown hostnames, and hides the
runtime health endpoint from public callers.

1. Copy `gateway.example.yaml` outside the checkout and replace
   `relay.example.com` with your public hostname.
2. Obtain a certificate for that hostname and install it:

   ```sh
   kube create secret tls relay-celld-tls \
     --cert=/absolute/path/to/fullchain.pem --key=/absolute/path/to/privkey.pem \
     --dry-run=client -o yaml | kube apply -f -
   ```

3. Set `CELLD_TRUST_FORWARDED_HEADERS: "1"` in your overlay and run `deploy.sh`
   again. The accepted values are `"0"` and `"1"`, not `true`/`false`.
4. Apply your edited gateway file and point DNS at its LoadBalancer:

   ```sh
   kube apply -f /absolute/path/to/relay-gateway.yaml
   kube rollout status deployment/relay-celld-gateway --timeout=180s
   kube get service relay-celld-gateway
   ```

The gateway requires an L4 load balancer that preserves source IP. Its
`externalTrafficPolicy: Local` avoids cross-node source NAT when supported by the
provider. Verify the source address in login audit before relying on IP rules.
If a trusted intermediary rewrites source addresses, configure a narrowly scoped
real-IP policy for that intermediary; do not trust arbitrary client-supplied
forwarding headers. The example does not automatically renew TLS certificates.
After a certificate or nginx ConfigMap update, restart the gateway to reload it:

```sh
kube rollout restart deployment/relay-celld-gateway
kube rollout status deployment/relay-celld-gateway --timeout=180s
```

With an existing ingress, implement the same contract: accept only the intended
host, terminate HTTPS, overwrite `X-Forwarded-Host`, `X-Forwarded-Proto` and
`CF-Connecting-IP` from trusted connection metadata, and remove `CF-Ray`. Add the
client label to that ingress's Pods and enable forwarded-header trust. If the
ingress is in another namespace, add an explicit `namespaceSelector` for that
namespace together with the Pod selector in the NetworkPolicy. Merely
adding an Ingress resource does not establish this contract. Correct scheme/host
forwarding is required for the dashboard's Origin checks, secure cookies and
webhook URLs.

celld does not populate Cloudflare's country metadata. Country is `XX`, country
flags are unavailable, and enabling country restrictions rejects requests whose
country cannot be established. Sending `CF-IPCountry` does not fix this: the
application reads `request.cf.country`. Leave country restrictions disabled for
this deployment until a verified metadata integration is added.

Once HTTPS is reachable, configure bots/applications and register webhooks in the
dashboard as described in the [main README](../../../README.md#connect-your-bots).

## Updates, restart and recovery

For each release, build/push the new image, update the overlay's immutable image
reference, and run `deploy.sh`. Publishing updates the shared fleet deployment;
a failed serving rollout does not automatically undo that publication. To roll
back application code, publish a previously built compatible image through the
same procedure. Preserve schema/migration compatibility and back up first.

To rotate the admin key, replace the key file, update `relay-celld-admin`, and run
the helper. Changing the Secret alone does not republish the Worker binding.
To rotate static storage credentials, update `relay-celld-storage` and run the
helper while both the old and new credentials remain valid, then revoke the old
ones after successful rollout.

For a runtime restart without republishing:

```sh
kube rollout restart statefulset/relay-celld
kube rollout status statefulset/relay-celld --timeout=360s
kube get pods,pvc
```

Keep the bucket/prefix, Worker name, Durable Object class names and PVC identity
stable. The bucket is the durable source of truth; the local PVC is not a backup
for it. A new bucket does not import existing Cloudflare data automatically.
Back up and restore the entire fleet consistently using your storage provider's
procedure. Deleting the namespace or bucket is not an application restart.

celld v0.6.3 is beta. The earlier restart checks established data and pending
alarm recovery on surviving storage; they did not establish storage-loss
recovery, multi-node failover, or exactly-once delivery under every failure.
Monitor native readiness, bucket failures, application delivery reports and
Telegram errors independently.

References: [celld security and forwarded-header policy](https://github.com/denoland/celld/blob/v0.6.3/docs/security.md),
[Kubernetes external traffic policy](https://kubernetes.io/docs/tasks/access-application-cluster/create-external-load-balancer/#preserving-the-client-source-ip),
[nginx request-header replacement](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header).
