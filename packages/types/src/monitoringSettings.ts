import { z } from 'zod';

export const MonitoringSettingsScope = z.enum(['WORKSPACE_POLICY', 'MEMBER_OVERRIDE']);
export type MonitoringSettingsScope = z.infer<typeof MonitoringSettingsScope>;

export const MonitoringSettingsRiskLevel = z.enum(['NORMAL', 'CAUTION', 'HIGH']);
export type MonitoringSettingsRiskLevel = z.infer<typeof MonitoringSettingsRiskLevel>;

export const MonitoringSettingsAuditPerson = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
export type MonitoringSettingsAuditPerson = z.infer<typeof MonitoringSettingsAuditPerson>;

export const MonitoringSettingsAuditDto = z.object({
  id: z.string(),
  scope: MonitoringSettingsScope,
  riskLevel: MonitoringSettingsRiskLevel,
  actor: MonitoringSettingsAuditPerson.nullable(),
  targetUser: MonitoringSettingsAuditPerson.nullable(),
  previousScreenshotIntervalMin: z.number().int().nullable(),
  previousIdleThresholdMin: z.number().int().nullable(),
  nextScreenshotIntervalMin: z.number().int().nullable(),
  nextIdleThresholdMin: z.number().int().nullable(),
  reason: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type MonitoringSettingsAuditDto = z.infer<typeof MonitoringSettingsAuditDto>;

export const MonitoringSettingsAuditListResponse = z.object({
  audits: z.array(MonitoringSettingsAuditDto),
});
export type MonitoringSettingsAuditListResponse = z.infer<typeof MonitoringSettingsAuditListResponse>;
