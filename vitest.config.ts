import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: './src/index.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      // Tests run offline: remote bindings (the send_email binding) use the local simulator; email tests inject a fake transport.
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          SESSION_SECRET: 'test-session-secret-0123456789abcdef',
          PII_ENCRYPTION_KEY: 'test-pii-encryption-key-0123456789abcdef',
          OPERATOR_TOKEN: 'test-operator-token-0123456789abcdef0123',
          GITHUB_CLIENT_ID: 'gh-test', GITHUB_CLIENT_SECRET: 'gh-secret',
          GOOGLE_CLIENT_ID: 'g-test', GOOGLE_CLIENT_SECRET: 'g-secret',
          REFERRAL_HOLD_DAYS: '30',
          // Staging runs PayPal sandbox; tests default to simulated money and opt into sandbox per test.
          PAYMENT_MODE: 'simulated',
          // Tests exercise the inline regex screen; the AI pipeline is tested with injected fakes.
          MODERATION_MODE: 'screen',
        },
      },
    })),
  ],
  // Agent worktrees under .claude/ hold full repo copies; never collect their tests.
  test: { setupFiles: ['./test/apply-migrations.ts'], exclude: [...configDefaults.exclude, '.claude/**'] },
});
