import { Router } from 'express';
import { getLatestAgentDownloadUrl, isAgentDownloadPlatform } from '../downloads/agentDownloads';

export const downloadsRouter = Router();

downloadsRouter.get('/agent/:platform', async (req, res, next) => {
  try {
    const { platform } = req.params;
    if (!isAgentDownloadPlatform(platform)) {
      return res.status(404).json({ error: 'unknown_platform' });
    }

    const url = await getLatestAgentDownloadUrl(platform);
    if (!url) {
      return res.status(503).json({ error: 'download_not_available' });
    }

    res.redirect(302, url);
  } catch (err) {
    next(err);
  }
});
