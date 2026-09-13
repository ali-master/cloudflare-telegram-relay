import { AppError, type NotificationInput, type SourceContext } from './types';
import { notificationInput, object } from './validation';
const severity = (value: unknown): NotificationInput['level'] => {
  const val = String(value || '').toLowerCase();
  return val === 'critical' || val === 'fatal' ? 'critical' : val === 'error' ? 'error' : val === 'warning' || val === 'warn' ? 'warning' : 'info';
};
const text = (value: unknown, fallback: string, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
function labelIdentity(prefix: string, labels: Record<string, unknown>, groupKey?: unknown): string {
  const identity = typeof groupKey === 'string' && groupKey ? groupKey : JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  // Bound long provider group keys without discarding distinguishing label values.
  let hash = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(identity)) hash = BigInt.asUintN(128, (hash ^ BigInt(byte)) * 0x1000000000000000000013bn);
  return `${prefix}:${hash.toString(16).padStart(32, '0')}`;
}
export function alertmanagerInputs(value: unknown, source: SourceContext): NotificationInput[] {
  const body = object(value);
  if (!Array.isArray(body.alerts) || body.alerts.length < 1 || body.alerts.length > 20) throw new AppError(400, 'INVALID_ALERTS', 'هر درخواست باید بین ۱ تا ۲۰ هشدار داشته باشد.');
  return body.alerts.map(raw => {
    const alert = object(raw), labels = object(alert.labels || {}), annotations = object(alert.annotations || {});
    const resolved = alert.status === 'resolved';
    const timestamp = resolved && alert.endsAt ? alert.endsAt : alert.startsAt;
    const payload: Record<string, unknown> = {
      application: text(labels.application || labels.app || labels.job, 'Alertmanager', 80),
      event: text(labels.alertname, 'alert', 65) + (resolved ? '.resolved' : '.firing'),
      level: resolved ? 'success' : severity(labels.severity),
      text: text(annotations.description || annotations.summary, text(labels.alertname, 'Alertmanager notification', 80), 2200),
      title: text(annotations.summary, text(labels.alertname, 'Alertmanager', 80), 160),
      environment: text(labels.environment, 'monitoring', 80),
      fingerprint: alert.fingerprint === undefined ? labelIdentity('alertmanager', labels) : alert.fingerprint,
      incidentStatus: resolved ? 'resolved' : 'firing',
    };
    if (timestamp) payload.timestamp = timestamp;
    if (typeof alert.generatorURL === 'string' && alert.generatorURL.startsWith('https://')) payload.url = alert.generatorURL;
    return notificationInput(payload, source);
  });
}
export function grafanaInput(value: unknown, source: SourceContext): NotificationInput {
  const body = object(value), labels = object(body.commonLabels || {});
  return notificationInput({
    application: text(labels.application || labels.app, 'Grafana', 80),
    event: body.status === 'resolved' ? 'alert.resolved' : 'alert.firing',
    level: body.status === 'resolved' ? 'success' : severity(labels.severity || 'warning'),
    title: text(body.title, 'Grafana alert', 160),
    text: text(body.message, 'Grafana notification', 2600),
    environment: text(labels.environment, 'monitoring', 80),
    fingerprint: body.fingerprint === undefined ? labelIdentity('grafana', labels, body.groupKey) : body.fingerprint,
    incidentStatus: body.status === 'resolved' ? 'resolved' : 'firing',
    ...(typeof body.externalURL === 'string' && body.externalURL.startsWith('https://') ? { url: body.externalURL } : {}),
  }, source);
}
