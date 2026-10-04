import type {NotificationHub} from './hub';
import type {TenantRegistry} from './tenants';
import {DEFAULT_WELCOME_MESSAGE} from './subscription-menu';

export interface Env {
  HUB: DurableObjectNamespace<NotificationHub>;
  TENANTS: DurableObjectNamespace<TenantRegistry>;
  ASSETS: Fetcher;
  API_KEY: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export type LoginAuditOutcome = 'invalid_key' | 'rate_limited';

export interface LoginAuditInput {
  ip: string;
  country: string;
  userAgent: string;
  requestId: string | null;
  outcome: LoginAuditOutcome;
}

export interface LoginAuditEntry extends LoginAuditInput {
  id: string;
  createdAt: string
}

export interface LoginAuditQuery {
  limit?: number;
  offset?: number;
  ip?: string;
  country?: string;
  outcome?: LoginAuditOutcome
}

export interface LoginAuditPage {
  entries: LoginAuditEntry[];
  total: number;
  limit: number;
  offset: number
}

export interface TenantLimits {
  requestsPerMinute: number;
  notificationsPerDay: number;
  maxSubscribers: number;
  maxPendingDeliveries: number;
}

export const DEFAULT_TENANT_LIMITS: TenantLimits = {
  requestsPerMinute: 120, notificationsPerDay: 10_000,
  maxSubscribers: 10_000, maxPendingDeliveries: 100_000,
};

export interface Tenant {
  id: string;
  name: string;
  enabled: boolean;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  limits: TenantLimits;
  botConfigured: boolean;
  botId: string | null;
  botUsername: string | null;
}

export interface TelegramBot {
  id: string;
  applicationCount?: number;
  name: string;
  enabled: boolean;
  configured: boolean;
  telegramId: string | null;
  username: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TelegramBotCreate {
  id: string;
  name: string;
  botToken: string;
  enabled?: boolean;
}

export interface TelegramBotUpdate {
  name?: string;
  enabled?: boolean;
  botToken?: string;
  expectedVersion?: number;
}

// Internal RPC data only. Never serialize this to an HTTP response.
export interface TenantRuntime extends Tenant {
  selectedBotId: string;
  botEnabled: boolean;
  botVersion: number;
  botToken: string;
  webhookSecret: string;
  applicationRevision: string;
  applications?: Application[];
}

export interface TenantCreate {
  id: string;
  name: string;
  limits?: Partial<TenantLimits>
}

export interface TenantUpdate {
  name?: string;
  enabled?: boolean;
  limits?: Partial<TenantLimits>;
  expectedVersion?: number
}

export interface TenantUsage {
  day: string;
  notificationsToday: number;
  activeSubscribers: number;
  pendingDeliveries: number;
}

export interface BotStatus {
  configured: { bot: boolean; webhookSecret: boolean; apiKey: boolean };
  bot: Record<string, unknown> | null;
  webhook: Record<string, unknown> | null;
  telegramError?: string;
  checkedAt: string;
}

export const hubName = (tenantId: string, botId = 'default') => botId === 'default'
  ? tenantId === 'default' ? 'primary' : `tenant:${tenantId}`
  : `tenant:${tenantId}:bot:${botId}`;

export interface Application {
  id: string;
  botId: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  isLegacy: boolean;
  keyConfigured: boolean;
  audienceMode: 'all' | 'selected';
  audienceChatIds: string[];
  showInDirectory: boolean;
}

export interface ApplicationCreate {
  id: string;
  botId?: string;
  name: string;
  audienceMode?: 'all' | 'selected';
  audienceChatIds?: string[];
  showInDirectory?: boolean;
}

export interface ApplicationUpdate {
  botId?: string;
  name?: string;
  enabled?: boolean;
  expectedVersion?: number;
  audienceMode?: 'all' | 'selected';
  audienceChatIds?: string[];
  showInDirectory?: boolean;
}

export const LEVELS = ['info', 'success', 'warning', 'error', 'critical'] as const;
export type Level = (typeof LEVELS)[number];

export interface NotificationInput {
  application: string;
  applicationId?: string;
  event: string;
  level: Level;
  timestamp: string;
  text: string;
  title?: string;
  image?: string;
  url?: string;
  environment?: string;
  metadata?: Record<string, string | number | boolean>;
  tags?: string[];
  silent?: boolean;
  fingerprint?: string;
  incidentStatus?: 'firing' | 'resolved';
}

export interface SourceContext {
  ip: string;
  country: string;
  source: string
}

export interface Settings {
  projectName: string;
  paused: boolean;
  ipMode: 'off' | 'allow' | 'deny';
  ipRules: string[];
  countryMode: 'off' | 'allow' | 'deny';
  countries: string[];
  showCountryFlag: boolean;
  deliveryPerSecond: number;
  retentionDays: number;
  welcomeMessage: string;
}

export const DEFAULT_SETTINGS: Settings = {
  projectName: 'Telegram Relay', paused: false, ipMode: 'off', ipRules: [],
  countryMode: 'off', countries: [], showCountryFlag: true,
  deliveryPerSecond: 10, retentionDays: 30,
  welcomeMessage: DEFAULT_WELCOME_MESSAGE,
};

export type DeliveryStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'skipped';

export interface NotificationRecord extends NotificationInput {
  id: string;
  incidentId?: string;
  grouped?: boolean;
  createdAt: string;
  source: SourceContext;
  status: 'queued' | 'sending' | 'completed' | 'partial' | 'failed' | 'empty';
  total: number;
  sent: number;
  failed: number;
  pending: number;
  unknown: number;
  skipped: number;
}

export interface Subscriber {
  chatId: string;
  firstName: string;
  username: string | null;
  active: boolean;
  joinedAt: string;
  updatedAt: string;
  banned: boolean;
  banReason: string | null;
  applicationMode: 'all' | 'selected';
  applicationIds: string[];
  displayName: string | null;
  notes: string;
  accessMode: 'all' | 'selected';
  allowedApplicationIds: string[];
  version: number;
}

export interface SubscriberUpdate {
  expectedVersion: number;
  displayName?: string | null;
  notes?: string;
  accessMode?: 'all' | 'selected';
  allowedApplicationIds?: string[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number
}

export interface Overview {
  subscribers: { total: number; active: number };
  notifications: { total: number; today: number };
  deliveries: { sent: number; failed: number; pending: number; unknown: number; skipped: number };
  daily: Array<{ date: string; sent: number; failed: number }>;
  levels: Array<{ level: Level; count: number }>;
  recent: NotificationRecord[];
}

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
