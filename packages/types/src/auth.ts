import { z } from 'zod';

export const Role = z.enum(['ADMIN', 'MANAGER', 'MEMBER']);
export type Role = z.infer<typeof Role>;

export const UserDto = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  role: Role,
  displayRole: Role,
  capabilities: z.array(z.string()),
  workspaceId: z.string(),
  teamId: z.string().nullable(),
  managerId: z.string().nullable(),
});
export type UserDto = z.infer<typeof UserDto>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  deviceName: z.string().max(100).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: UserDto,
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const RefreshRequest = z.object({
  refreshToken: z.string(),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export const RefreshResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type RefreshResponse = z.infer<typeof RefreshResponse>;

export const LogoutRequest = z.object({
  refreshToken: z.string(),
});
export type LogoutRequest = z.infer<typeof LogoutRequest>;

export const LogoutResponse = z.object({
  ok: z.literal(true),
});
export type LogoutResponse = z.infer<typeof LogoutResponse>;
