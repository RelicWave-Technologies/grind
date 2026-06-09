import { Router } from 'express';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireCapability } from '../middleware/scope';
import { loadProfileForUser } from '../profile/service';

export const profileRouter = Router();
profileRouter.use(requireAccessToken, attachScope, requireCapability('profile.self.read'));

profileRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const response = await loadProfileForUser(req.user.sub, req.user.ws);
    if (!response) return res.status(401).json({ error: 'unauthorized' });
    if ('error' in response) return res.status(503).json({ error: response.error });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default profileRouter;
