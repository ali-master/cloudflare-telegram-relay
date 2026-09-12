import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: {
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      bindings: {
        API_KEY: 'test-admin-key-which-is-not-a-production-secret',
        TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      },
    },
  })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 15000 },
});
