# Integration recipes

Use the deployed origin as `RELAY_URL`, the tenant ID as `RELAY_TENANT`, and that tenant application's API key as `RELAY_APPLICATION_KEY`. All public endpoints require the key in a Bearer or `X-API-Key` header. The master `API_KEY` is for admin login only. Application identity and display name come from the key; a JSON `application` value is a compatibility field and cannot change the sender. Each tenant's IP/country policy and quotas apply.

The explicit tenant base path is `/api/v1/tenants/{tenantId}`. Existing `/api/v1` paths address tenant `default` only. Create or rotate the application's key in the dashboard, then store that key in the producer's secret store. Producer credentials are not read from the Worker's environment.

A successful new enqueue returns HTTP `202` and `{ "notification": { "id": "…", "status": "queued", "…": "…" }, "duplicate": false }`. The generic endpoint returns `200` for an existing idempotent request. Inspect `notification.id` in the dashboard or with `GET /api/v1/tenants/{tenantId}/notifications/{id}` to learn the delivery result. There must be an active, unbanned subscriber whose `/apps` selection includes this application (the initial `/start` default is all applications). An application key can query only its own notifications.

## Generic JSON producer

Build JSON with a serializer instead of interpolating application text into JSON strings. Preserve the same payload and `Idempotency-Key` when retrying one event.

```sh
jq -n \
  --arg application 'Payments API' \
  --arg text 'Database latency has exceeded 500 ms for five minutes.' \
  '{
    application: $application,
    event: "latency.threshold_exceeded",
    level: "warning",
    text: $text,
    environment: "production",
    metadata: { threshold_ms: 500 },
    tags: ["database", "latency"]
  }' > notification.json

curl --fail-with-body --retry 3 --retry-delay 2 \
  --connect-timeout 10 --max-time 30 \
  --request POST "$RELAY_URL/api/v1/tenants/$RELAY_TENANT/notifications" \
  --header "Authorization: Bearer $RELAY_APPLICATION_KEY" \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: incident-db-latency-123-firing' \
  --data-binary @notification.json
```

Use a new key for the resolved event. If the producer changes any event content, it must also change the key; the relay returns `409` when an existing key is reused with a different payload. Do not add a freshly generated timestamp on each retry of the same event.

Images use an optional `image` field containing a public HTTPS URL or a Telegram `file_id` belonging to the same bot. Telegram must be able to retrieve the URL; an image behind your application login will not work. The relay does not receive multipart uploads.

## GitHub Actions

In your repository, create Actions variables `RELAY_URL` and `RELAY_TENANT`, and an Actions secret `RELAY_APPLICATION_KEY`. Add this job to a workflow with an existing `deploy` job. It sends one notification when deployment succeeds or fails.

```yaml
notify:
  name: Notify Telegram subscribers
  needs: [deploy]
  if: ${{ always() && (needs.deploy.result == 'success' || needs.deploy.result == 'failure') }}
  runs-on: ubuntu-latest
  timeout-minutes: 2
  permissions:
    contents: read
  env:
    RELAY_URL: ${{ vars.RELAY_URL }}
    RELAY_TENANT: ${{ vars.RELAY_TENANT }}
    RELAY_APPLICATION_KEY: ${{ secrets.RELAY_APPLICATION_KEY }}
    DEPLOY_RESULT: ${{ needs.deploy.result }}
    RELAY_APP: ${{ github.repository }}
    RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
  steps:
    - name: Broadcast deployment result
      shell: bash
      run: |
        set -euo pipefail
        level=success
        if [ "$DEPLOY_RESULT" != success ]; then level=error; fi

        jq -n \
          --arg application "$RELAY_APP" \
          --arg level "$level" \
          --arg result "$DEPLOY_RESULT" \
          --arg url "$RUN_URL" \
          --arg commit "$GITHUB_SHA" \
          --arg run "$GITHUB_RUN_ID" \
          '{
            application: $application,
            event: "deployment.completed",
            level: $level,
            text: ("Deployment finished with status: " + $result),
            environment: "production",
            url: $url,
            metadata: {commit: $commit, run: $run},
            tags: ["github-actions", "deploy"]
          }' > notification.json

        curl --fail-with-body --retry 3 --retry-delay 2 \
          --connect-timeout 10 --max-time 30 \
          --request POST "$RELAY_URL/api/v1/tenants/$RELAY_TENANT/notifications" \
          --header "Authorization: Bearer $RELAY_APPLICATION_KEY" \
          --header 'Content-Type: application/json' \
          --header "Idempotency-Key: github-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-deploy" \
          --data-binary @notification.json
```

Repository and event values enter `jq` through environment variables and serializer arguments. Avoid placing untrusted commit messages directly inside workflow shell code. This sample treats a failed notification request as a failed notification job; the deployment job's own result remains available separately.

GitHub-hosted runner egress IP addresses can change. An IP allowlist must account for the producer's actual egress network; a self-hosted runner with fixed egress is easier to restrict. Do not infer runner country from a repository owner's location.

## GitLab CI

Create masked CI/CD variable `RELAY_APPLICATION_KEY` and variables `RELAY_URL` and `RELAY_TENANT`. Add the notification stages after your existing deployment stage. Select variable protection according to the branches allowed to send notifications.

```yaml
stages:
  - build
  - test
  - deploy
  - notify

.notify-telegram:
  stage: notify
  image: alpine:3.22
  before_script:
    - apk add --no-cache curl jq
  script:
    - |
      jq -n \
        --arg application "$CI_PROJECT_PATH" \
        --arg level "$RELAY_LEVEL" \
        --arg result "$RELAY_RESULT" \
        --arg pipeline "$CI_PIPELINE_ID" \
        --arg commit "$CI_COMMIT_SHA" \
        --arg url "$CI_PIPELINE_URL" \
        '{
          application: $application,
          event: "pipeline.completed",
          level: $level,
          text: ("Pipeline finished with status: " + $result),
          url: $url,
          metadata: {pipeline: $pipeline, commit: $commit},
          tags: ["gitlab-ci"]
        }' > notification.json

      curl --fail-with-body --retry 3 --retry-delay 2 \
        --connect-timeout 10 --max-time 30 \
        --request POST "$RELAY_URL/api/v1/tenants/$RELAY_TENANT/notifications" \
        --header "Authorization: Bearer $RELAY_APPLICATION_KEY" \
        --header 'Content-Type: application/json' \
        --header "Idempotency-Key: gitlab-$CI_PROJECT_ID-$CI_PIPELINE_ID-$RELAY_RESULT" \
        --data-binary @notification.json
  timeout: 2m

notify-success:
  extends: .notify-telegram
  when: on_success
  variables:
    RELAY_LEVEL: success
    RELAY_RESULT: success

notify-failure:
  extends: .notify-telegram
  when: on_failure
  variables:
    RELAY_LEVEL: error
    RELAY_RESULT: failure
```

The two jobs describe the preceding pipeline result. They do not use `CI_JOB_STATUS`, which would describe the notification job itself. Retrying the same notification job uses the same payload and key; a different result gets a separate key.

## Prometheus Alertmanager

Use the native adapter URL `/api/v1/tenants/{tenantId}/integrations/alertmanager`. The relay expands a webhook's `alerts` array into individual notification records, using `alertname` and firing/resolved state to name each event. Each request must contain 1–20 alerts.

Merge this receiver and route into your existing Alertmanager configuration:

```yaml
route:
  receiver: telegram-relay
  group_by: [alertname, service]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: telegram-relay
    webhook_configs:
      - url: https://your-relay.your-subdomain.workers.dev/api/v1/tenants/payments/integrations/alertmanager
        send_resolved: true
        max_alerts: 20
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/relay-notify-key
```

The credentials file must contain the producer key and be readable by Alertmanager. `http_config.authorization` and `webhook_configs` are documented in the [official Alertmanager configuration reference](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).

The application key determines the sender and overrides all incoming application labels. `labels.environment` and `labels.severity` supply environment and severity. `labels.alertname` becomes the event name plus `.firing` or `.resolved`; `annotations.summary` supplies the title and `annotations.description` (falling back to summary) supplies the message. Resolved alerts use `success` severity and `endsAt`; firing alerts use `startsAt`. An HTTPS `generatorURL` becomes the source link. Unmapped labels are not copied into metadata. Selected fields are truncated to the relay's limits.

The adapter returns `{ "notifications": [{ "notification": { "id": "…", "…": "…" }, "duplicate": false }] }`. Keep the full JSON body within 64 KiB. Batch enqueue is sequential: if a later enqueue fails, earlier alerts may already be accepted. The default Alertmanager webhook supplies no unique `Idempotency-Key`, so its HTTP retries and scheduled repeats can create new broadcasts. A custom sender can supply a stable header to deduplicate retries; preserve both content and array order because the adapter appends each alert's index to the key. Request success means records were queued, not delivered.

## Grafana Alerting

Create a contact point with a **Webhook** integration:

| Setting | Value |
| --- | --- |
| URL | `https://your-relay.your-subdomain.workers.dev/api/v1/tenants/payments/integrations/grafana` |
| HTTP Method | `POST` |
| Authentication Header Scheme | `Bearer` |
| Authentication Header Credentials | Your producer key |
| Max Alerts | A bounded group size, for example `20` |
| Title / Message | Optional templates to summarize the alert group |

Keep the default Grafana JSON payload. The relay creates one group notification using `title`, `message`, `status`, `commonLabels.severity`, `commonLabels.environment`, and HTTPS `externalURL`. The application key supplies the sender identity. Individual alert entries are not expanded or copied into metadata. Selected fields are truncated to normalized limits; the whole request must still fit 64 KiB. Without a stable `Idempotency-Key`, retries can create another broadcast.

Save the contact point, attach it to a notification policy, then use Grafana's test action. Authenticate through the authorization fields; no query-string token or Basic Authentication is supported by this relay. The adapter authenticates the API key; Grafana HMAC signing is not implemented.

The contact-point fields and native payload are described in [Grafana's webhook notifier documentation](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/).

## Diagnosing integration failures

| Observation | Check |
| --- | --- |
| `401` | Correct application key and tenant path; the master admin key cannot send. Check whether the application/key was disabled or rotated. |
| `403` | Tenant enabled state and its IP/country policy against the producer's egress context. |
| `400` or `413` | JSON shape, field lengths, combined formatted length, or the 64 KiB body limit. |
| `409` | The same application's idempotency key was used for different content. |
| `429` | Per-tenant minute/daily/subscriber/queue quota; inspect the error code and usage dashboard. |
| `202` with an empty audience | Bot webhook registration and whether anyone has sent private `/start`. |
| Queued messages remain pending | Pause settings, rate limits, queue progress, and Worker runtime logs. |
| `failed` delivery | Telegram rejection details, token validity, blocked chats, or inaccessible image URLs. |
| `unknown` delivery | Outcome could not be confirmed; inspect Telegram before deciding whether to submit a new broadcast. |

Use the returned record ID for correlation. Do not put tokens, passwords, or other credentials in message text or metadata: every eligible subscriber receives that content. A subscriber can restrict applications with `/apps`; use `/all` to restore all-application delivery.
