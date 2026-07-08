import { z } from 'zod';

export const API_TOKEN_SCOPES = [
  'read:people',
  'read:device-health',
  'read:time-summary',
  'read:manual-time',
] as const;

export const ApiTokenScopeSchema = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>;

export const CreateApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(ApiTokenScopeSchema).min(1).max(API_TOKEN_SCOPES.length),
});

export type CreateApiTokenRequestDto = z.infer<typeof CreateApiTokenRequest>;

export interface ApiTokenDto {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: ApiTokenScope[];
  createdBy: {
    id: string;
    name: string;
    email: string;
  };
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreateApiTokenResponse {
  apiToken: ApiTokenDto;
  token: string;
}
