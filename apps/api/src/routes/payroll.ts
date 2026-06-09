import { Router } from 'express';
import { PatchPayrollPolicyRequest } from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';
import { formatPayrollCsv } from '../payroll/monthly';
import {
  buildPayrollPayload,
  loadOrCreatePayrollPolicy,
  patchPayrollPolicy,
  resolvePayrollMonth,
  toPolicyDto,
} from '../payroll/service';

/**
 * Admin payroll worksheet + policy.
 *
 * This is a classifier/export surface only. It does not execute payment.
 * The pure calculation lives in payroll/monthly.ts; this route only enforces
 * admin RBAC, validates policy changes, and shapes JSON/CSV responses.
 */
export const payrollRouter = Router();
payrollRouter.use(requireAccessToken, attachScope, requireAdmin);

payrollRouter.get('/policy', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const policy = await loadOrCreatePayrollPolicy(req.scope.workspaceId);
    res.json(toPolicyDto(policy));
  } catch (err) {
    next(err);
  }
});

payrollRouter.patch('/policy', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const parsed = PatchPayrollPolicyRequest.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message ?? 'invalid_payroll_policy',
      });
    }
    const result = await patchPayrollPolicy(req.scope.workspaceId, parsed.data);
    if ('error' in result) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

payrollRouter.get('/monthly', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const policy = await loadOrCreatePayrollPolicy(req.scope.workspaceId);
    const range = resolvePayrollMonth(req.query, policy.timezone);
    if ('error' in range) return res.status(400).json({ error: range.error });
    const result = await buildPayrollPayload(req.scope.workspaceId, range);
    if ('error' in result) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

payrollRouter.get('/monthly.csv', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    const policy = await loadOrCreatePayrollPolicy(req.scope.workspaceId);
    const range = resolvePayrollMonth(req.query, policy.timezone);
    if ('error' in range) return res.status(400).json({ error: range.error });
    const result = await buildPayrollPayload(req.scope.workspaceId, range);
    if ('error' in result) return res.status(400).json({ error: result.error });
    const csv = formatPayrollCsv(result.payroll);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="grind-payroll-${range.month}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default payrollRouter;
