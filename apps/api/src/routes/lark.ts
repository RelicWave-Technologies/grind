import { Router } from 'express';
import { requireAccessToken } from '../middleware/auth';
import { isLarkConfigured, getTokenManager, LARK_SCOPES } from '../lark';

export const larkRouter = Router();

larkRouter.use(requireAccessToken);

/**
 * Connection status for the signed-in user. Always 200 — the renderer uses
 * `configured` to decide whether to show the "Connect Lark" affordance, and
 * `reauthRequired` to surface the "reconnect Lark" recovery prompt.
 */
larkRouter.get('/status', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const configured = isLarkConfigured();
    if (!configured) {
      return res.json({
        configured: false,
        connected: false,
        reauthRequired: false,
        scopes: [],
      });
    }
    const tm = getTokenManager()!;
    const status = await tm.getStatus(req.user.sub);
    res.json({
      configured: true,
      connected: status.connected,
      reauthRequired: status.reauthRequired,
      scopes: status.scopes,
      requestedScopes: LARK_SCOPES,
      refreshExpiresAt: status.refreshExpiresAt,
      lastRefreshedAt: status.lastRefreshedAt,
    });
  } catch (err) {
    next(err);
  }
});

export default larkRouter;
