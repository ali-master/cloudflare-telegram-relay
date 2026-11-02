# Argo CD overlay example

This is a sanitized example of a GitOps deployment. It is not watched by Argo CD
and is not deployable as-is. The active deployment belongs in the operator's
private GitOps repository. Adding or changing files here does not update a
cluster, publish an image, or register a Telegram webhook.

The overlay extends `../../base` with:

- Sync waves that apply configuration before the publishing Job and start the
  runtime only after publication succeeds.
- A registry pull Secret reference for the publishing Job and StatefulSet.
- An HTTPS `HTTPRoute`, redirect route, and network policy for a trusted Envoy
  Gateway. The route replaces forwarded host and protocol headers and removes
  untrusted client-supplied IP headers.
- A runtime-only HTTPS proxy. Object storage and cluster-local traffic bypass it.
- A retained PVC request and Celld's optional S3 conditional-write setting.

Before adapting this example in a private GitOps repository, replace every
`example.com`, `CHANGE_ME`, `replace-me`, `your-retained-storage-class`, image
reference, gateway reference, listener name, and registry Secret name. Pin the
image to a built, tested immutable reference. Enable `CELLD_S3_BARE_IF_MATCH`
only when that image includes the matching Celld patch and the storage provider
requires it. Verify the network policy selectors against the actual Gateway
Pods and confirm that the Gateway listener and TLS certificate exist.

Keep the admin key, bot tokens, storage credentials, registry credentials,
subscriber data, and backups out of Git. The overlay references Kubernetes
Secrets by name; create them through the private operator workflow described in
the [Kubernetes deployment guide](../../README.md#2-install-secrets).

Render locally for review:

```sh
kubectl kustomize deploy/celld/kubernetes/overlays/argocd-example
```

Rendering does not apply resources. Do not point an Argo CD Application at this
example path. Deploy only a reviewed, environment-specific overlay from the
private GitOps repository.
