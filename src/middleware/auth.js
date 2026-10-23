import { config } from '../config.js';
import { parseApiKeys } from '../lib/keyManager.js';

function extractProvidedKey(req) {
  const authHeader = req.headers['authorization'] || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch) return bearerMatch[1].trim();

  if (req.headers['x-goog-api-key']) return String(req.headers['x-goog-api-key']).trim();
  if (req.headers['x-proxy-key']) return String(req.headers['x-proxy-key']).trim();
  if (typeof req.query?.key === 'string' && req.query.key) return req.query.key.trim();

  return '';
}

export function resolveApiKey(req, res, next, cfg = config) {
  const provided = extractProvidedKey(req);

  function useKeys(rawKeySource) {
    const keys = parseApiKeys(rawKeySource);
    req.geminiApiKeys = keys.length ? keys : [rawKeySource];
    req.geminiApiKey = req.geminiApiKeys[0];
  }

  // Password mode: user supplies PROXY_API_KEY
  if (cfg.proxyApiKey && provided === cfg.proxyApiKey) {
    if (cfg.geminiApiKey) {
      useKeys(cfg.geminiApiKey);
    } else if (cfg.gcpServiceAccount) {
      req.geminiApiKeys = ['vertex-service-account'];
      req.geminiApiKey = 'vertex-service-account';
    } else {
      return res.status(500).json({
        error: 'PROXY_API_KEY is set but neither GEMINI_API_KEY nor GCP_SERVICE_ACCOUNT_KEY is configured.',
      });
    }
    return next();
  }

  // Key forwarded directly from client (BYOK)
  if (provided) {
    useKeys(provided);
    return next();
  }

  // Fallbacks configured on the server
  if (cfg.geminiApiKey) {
    useKeys(cfg.geminiApiKey);
    return next();
  }

  if (cfg.gcpServiceAccount) {
    req.geminiApiKeys = ['vertex-service-account'];
    req.geminiApiKey = 'vertex-service-account';
    return next();
  }

  return res.status(401).json({
    error:
      'No Gemini API key found on the request. Send it as "Authorization: Bearer <key>", ' +
      'or configure GCP_SERVICE_ACCOUNT_KEY / GEMINI_API_KEY on the server.',
  });
}
