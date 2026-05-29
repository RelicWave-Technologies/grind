import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  DIRECT_URL: z.string().url().optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().min(3600).default(60 * 60 * 24 * 30),

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
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
