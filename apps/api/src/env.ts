import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // PORT is injected by most PaaS hosts (Render, Heroku, Railway). When set it
  // wins over API_PORT so the service binds where the platform expects.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  // 90-day sliding window: every use rotates the refresh token and resets this
  // clock, so an active session effectively never expires while access tokens
  // stay short-lived (15m) and revocable. Re-login only after 90d of inactivity.
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(60 * 60 * 24 * 90),

  // --- Lark / Feishu (optional; integration is disabled when unset) ---
  // International tenant by default. Provide creds from the Lark Developer Console.
  LARK_APP_ID: z.string().min(1).optional(),
  LARK_APP_SECRET: z.string().min(1).optional(),
  // 32-byte key (base64 or base64url) used to encrypt OAuth refresh tokens at rest.
  LARK_TOKEN_KEY: z.string().min(1).optional(),
  // OAuth v2 host + redirect; sensible larksuite.com defaults.
  LARK_OAUTH_HOST: z.string().url().default('https://open.larksuite.com'),
  LARK_ACCOUNTS_HOST: z.string().url().default('https://accounts.larksuite.com'),
  LARK_OAUTH_REDIRECT_URI: z.string().url().optional(),
  DASHBOARD_URL: z.string().url().optional(),

  // --- Lark login provisioning ---
  // Comma-separated emails created as ACTIVE ADMIN on first Lark login (they
  // bootstrap the workspace + grant everyone else's roles). Everyone else is
  // provisioned PENDING. Matching is case-insensitive + trimmed.
  LARK_BOOTSTRAP_ADMIN_EMAILS: z.string().optional(),
  // Fixed id for the single workspace, used with upsert so concurrent first
  // logins never create duplicates.
  WORKSPACE_ID: z.string().min(1).default('ws_default'),
  // DEV ONLY: when 'true' AND NODE_ENV!=='production', the legacy email/password
  // /v1/auth/login endpoint stays mounted (for local dev + tests without a live
  // Lark tenant). Hard-off in production regardless of value.
  ALLOW_PASSWORD_LOGIN: z.enum(['true', 'false']).default('false'),

  // --- Timo tester-ops AI brain ---
  TIMO_AI_ENABLED: z.enum(['true', 'false']).default('false'),
  TIMO_AI_PROVIDER: z.enum(['openrouter', 'deepseek']).default('openrouter'),
  TIMO_AI_MODEL: z.string().min(1).optional(),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  TIMO_AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  TIMO_AI_MAX_INPUT_CHARS: z.coerce.number().int().min(1000).max(50000).default(12000),
  TIMO_TESTER_BOT_ENABLED: z.enum(['true', 'false']).default('false'),
  TIMO_TESTER_GROUP_CHAT_ID: z.string().min(1).optional(),
  TIMO_TESTER_GROUP_TIMEZONE: z.string().min(1).default('UTC'),
  TIMO_TESTER_PING_TIMES: z.string().min(1).default('11:00,17:00'),
  TIMO_TESTER_HISTORY_POLL_INTERVAL_MS: z.coerce.number().int().min(3000).max(300000).default(5000),
  TIMO_PASSIVE_ISSUE_DETECTION_ENABLED: z.enum(['true', 'false']).default('false'),
  TIMO_CARD_MASCOT_IMAGE_KEY: z.string().min(1).optional(),
  TIMO_CARD_STREAMING_IMAGE_KEY: z.string().min(1).optional(),

  // Deploy schema/API first, then enable only after protocol-v2 checkpoints
  // are visible and the legacy cleanup dry run has been reviewed.
  TIMO_TIMER_LEASE_RECONCILER_ENABLED: z.enum(['true', 'false']).default('false'),

  // --- Screenshots (optional; direct URLs on Screenshot rows also work) ---
  PUBLIC_APP_URL: z.string().url().optional(),
  SCREENSHOT_ASSET_BASE_URL: z.string().url().optional(),
  SCREENSHOT_URL_SIGNING_SECRET: z.string().min(16).optional(),

  // --- Cloudinary (screenshot storage) ---
  // When all three are set, /v1/screenshots/sign mints signed direct-upload
  // params for the agent. The api_secret never leaves the server.
  CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
  CLOUDINARY_API_KEY: z.string().min(1).optional(),
  CLOUDINARY_API_SECRET: z.string().min(1).optional(),
  // Folder screenshots land in. Defaults to "grind/screenshots".
  CLOUDINARY_FOLDER: z.string().min(1).default('grind/screenshots'),

  // --- Google Drive (screenshot storage) ---
  // When configured, /v1/screenshots/sign returns a Grind upload URL that the
  // existing agent posts to with its Cloudinary-shaped multipart body. The API
  // stores bytes in Drive using this service account.
  GOOGLE_DRIVE_CLIENT_EMAIL: z.string().email().optional(),
  GOOGLE_DRIVE_PRIVATE_KEY: z.string().min(1).optional(),
  GOOGLE_DRIVE_PRIVATE_KEY_BASE64: z.string().min(1).optional(),
  GOOGLE_DRIVE_FOLDER_ID: z.string().min(1).optional(),
  GOOGLE_DRIVE_SHARED_DRIVE_ID: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
