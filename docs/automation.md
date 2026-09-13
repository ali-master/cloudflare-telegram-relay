# Incident response and delivery rules

The relay can group related alerts, track who is handling an incident, and batch lower-priority notifications into digests. Everything belongs to one tenant. Application policies inherit their tenant's defaults until you save an override.

Grouping, escalation, quiet hours, and digest delivery are off by default. Existing producers can keep sending the same payloads.

Incident tracking becomes active when the effective policy enables grouping or escalation, or defines at least one responder. Delivery rules alone do not create incidents. Sending `fingerprint` or `incidentStatus` does not enable tracking by itself.

## 1. Set up an application

1. Select the tenant in the dashboard, then open **قوانین ارسال**.
2. Choose tenant defaults or an application. Saving an application creates its override; resetting it restores inheritance.
3. Enable grouping and choose a window between 30 seconds and 24 hours. The window starts at the first accepted occurrence; later repeats do not extend it.
4. Choose responders and, optionally, an ordered escalation list and delay.
5. Add delivery rules and use the preview to check a sample application's level, environment, and recipient before enabling them.

Each save uses `expectedVersion` from the last read. A `409 VERSION_CONFLICT` or `409 STALE_AUTOMATION` means the configuration changed: reload it before saving. Do not retry a stale write with a blindly incremented version.

## 2. Link the firing and resolved events

Give related events the same `fingerprint` within one application. The same string in another application or tenant identifies a different problem. Keep instance identifiers in the fingerprint when two hosts or database instances must remain separate.

```json
{
  "event": "database.unavailable",
  "level": "critical",
  "text": "The primary database is unreachable.",
  "environment": "production",
  "fingerprint": "database:primary:production",
  "incidentStatus": "firing",
  "metadata": { "host": "db-primary", "timeout_ms": 5000 },
  "tags": ["database", "availability"]
}
```

When the underlying condition recovers, send a new event with the same fingerprint:

```json
{
  "event": "database.recovered",
  "level": "success",
  "text": "The primary database is healthy again.",
  "environment": "production",
  "fingerprint": "database:primary:production",
  "incidentStatus": "resolved"
}
```

POST both to `/api/v1/tenants/{tenantId}/notifications`, using the application's key in `X-API-Key` or `Authorization: Bearer`.

- `fingerprint` is an optional non-empty string of at most 160 characters.
- `incidentStatus` is either `firing` or `resolved`. A successful deployment is not automatically treated as the resolution of a different alert.
- `Idempotency-Key` identifies a particular HTTP request; `fingerprint` identifies the ongoing problem. Reuse the former only to retry an unchanged request. Use a new request key for each actual occurrence or resolution.
- Native Alertmanager and Grafana adapters normalize the incident identity and firing/resolved state from their webhook payloads.
- Without an explicit fingerprint, the fallback identity combines the event name (removing a trailing `.firing` or `.resolved`) and environment. It does not distinguish separate hosts; supply your own fingerprint when that matters.

The incident view shows the occurrence count, first and last event times, current owner, next escalation, and action history. Repeated occurrences update the tracked Telegram message, with ordinary edits coalesced over 30 seconds. Resolution and operator actions request an immediate update, still subject to queue rate limits and recipient preferences. The API retains each occurrence as a notification and marks shared incident deliveries with `grouped: true`.

A repeat after the grouping window starts a new incident. A recovery event closes all still-active incidents with the same application and fingerprint, including earlier windows, so an older occurrence cannot keep escalating after recovery.

## 3. Acknowledge, snooze, and resolve

Open **مرکز رخدادها**, select an incident, and use an action:

| Action | Effect |
| --- | --- |
| Acknowledge | Record that someone has taken responsibility and stop unanswered-incident escalation. |
| Snooze | Temporarily pause incident escalation until the selected deadline. |
| Resolve | Close the incident and stop its escalation. |

Eligible responders can also use the buttons on the Telegram incident message. A callback belongs to the clicking Telegram user; supplying another chat ID cannot grant access. Subscriber bans, application audience restrictions, and application subscriptions still apply.

The effective application's responder list controls who can act. An empty responder list allows otherwise eligible recipients. Dashboard administrators can also act. The timeline records actions and timestamps, and the incident overview reports acknowledgment time and escalation counts.

Escalation applies to unanswered critical incidents. Choose recipients in order and set the delay between escalation steps. Recipients must remain eligible when delivery occurs; escalation never grants application access or overrides a ban.

## 4. Route or summarize notifications

Delivery rules run in list order. The first enabled rule whose levels, environments, and tags match supplies the rule's delivery mode. Empty rule selectors match any value; every configured tag must be present.

| Mode | Use |
| --- | --- |
| `immediate` | Normal queue delivery, subject to the recipient's preferences and quiet hours. |
| `digest` | Combine notifications into a periodic summary. |
| `mute` | Suppress matching notifications. |

Example: place an `error`/`critical` production rule first, then an `info` staging digest rule. Rule order matters when selectors overlap. The preview evaluates the saved policy without creating notifications or contacting Telegram.

Limits: 50 rules per policy, 20 environment values and 10 tags per rule, and digest intervals of 5–1,440 minutes. Use separate application overrides when different services need different routing.

Each digest combines at most 20 due notifications for one recipient; additional items continue in later batches. Bodies are shortened to 300 characters in the digest, with available detail links retained. The source notifications remain available in the dashboard. When both a rule and the recipient request a digest, the longer interval applies. Digest deadlines remain fixed while queued and move past quiet hours when necessary.

## 5. Recipient preferences

In **Subscribers**, open a recipient's delivery preferences to configure:

- Levels and environments to receive. An empty environment selection means all environments; an empty level selection means no levels.
- Immediate delivery or a digest interval.
- An IANA time zone such as `Asia/Tehran` or `Europe/Berlin`.
- Quiet hours, including overnight windows such as `22:00`–`08:00`.
- Whether critical alerts bypass quiet hours and digest delays.

Critical bypass does not override level/environment filters, an explicit mute rule, application permissions, a disabled tenant, or a subscriber ban.

Subscribers can configure their private bot chat with:

```text
/preferences
/timezone Europe/Berlin
/quiet 22:00 08:00
```

`/quiet` sets and enables the local interval; its toggle in `/preferences` turns it off. The Telegram menu offers level toggles, all/production environments, immediate/digest delivery, quiet hours, and critical bypass. The dashboard supports arbitrary environment lists and custom digest intervals. Application selection remains available through `/apps`.

Schedules use the selected local time zone, including daylight-saving transitions. Digest and escalation deadlines are persisted and run through Durable Object alarms; the browser does not need to stay open.

## Administration API

These endpoints require the dashboard session cookie. All mutations also require an exact same-origin `Origin` header. Application ingestion keys cannot administer policies, preferences, or incidents.

All paths below are relative to `/api/admin/tenants/{tenantId}`. The existing `/api/admin` alias addresses the default tenant.

| Method | Path | Response / purpose |
| --- | --- | --- |
| GET | `/automation?applicationId=...` | `{policy, inherited}`; omit the application for tenant defaults. |
| PUT | `/automation?applicationId=...` | Save fields with `expectedVersion`; return `{policy, inherited}`. |
| DELETE | `/automation?applicationId=...&expectedVersion=...` | Reset an application's override to inheritance. |
| POST | `/automation/preview` | Evaluate `{applicationId, chatId?, level, environment?, tags?, timestamp?}`. |
| GET | `/incidents?page=1&status=open&applicationId=...` | Paginated incidents; status and application filters are optional. |
| GET | `/incidents/overview` | Tenant incident counts, occurrences, escalations, and acknowledgment time. |
| GET | `/incidents/{id}` | `{incident, timeline}`. |
| POST | `/incidents/{id}/actions` | `{action, expectedVersion, minutes?}`; actions: `acknowledge`, `snooze`, `resolve`. |
| GET | `/subscribers/{chatId}/preferences` | `{preferences}`. |
| PUT | `/subscribers/{chatId}/preferences` | Save preference fields with `expectedVersion`; return `{preferences}`. |

The preview response is `{mode, reason, nextAt}`. `nextAt` is a Unix timestamp in milliseconds or `null`. Incident timestamps are ISO 8601 strings; optional timestamps are `null` when not applicable.

Queues and incident actions remain subject to the tenant's quotas and delivery rate. A queued notification or a scheduled escalation is not proof of Telegram delivery; inspect delivery reports for the actual result.
