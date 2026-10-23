import 'dotenv/config';
import {
  RESPONSE_LENGTHS,
  NARRATION_MODES,
  DIALOGUE_RATIOS,
  PACINGS,
  normalizeChoice,
} from './lib/roleplayPrompts.js';

function optionalNumber(name) {
  return process.env[name] !== undefined ? Number(process.env[name]) : undefined;
}

export const config = {
  port: process.env.PORT || 8080,
  nodeEnv: process.env.NODE_ENV || 'production',

  // --- API key & Vertex handling -----------------------------------------
  geminiApiKey: process.env.GEMINI_API_KEY || undefined,
  proxyApiKey: process.env.PROXY_API_KEY || undefined,
  geminiBaseUrl: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',

  // Vertex AI / Google Cloud configuration ($300 GCP free quota)
  gcpServiceAccount: process.env.GCP_SERVICE_ACCOUNT_KEY || undefined,
  gcpRegion: process.env.GCP_REGION || 'global',

  // How long a key sits out of rotation after a transient error
  keyCooldownMs: Number(process.env.KEY_COOLDOWN_MS || 60_000),
  keyInvalidCooldownMs: Number(process.env.KEY_INVALID_COOLDOWN_MS || 24 * 60 * 60_000),

  safetyThresholds: {
    harassment: 'BLOCK_NONE',
    hateSpeech: 'BLOCK_NONE',
    sexuallyExplicit: 'BLOCK_NONE',
    dangerousContent: 'BLOCK_NONE',
  },

  enableAdultFraming: process.env.ENABLE_ADULT_FRAMING !== 'false',
  adultFramingText: process.env.ADULT_FRAMING_TEXT || undefined,

  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX || 180),
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 600_000),

  retryAttempts: Number(process.env.RETRY_ATTEMPTS || 1),
  retryBaseDelayMs: Number(process.env.RETRY_BASE_DELAY_MS || 500),

  // Waiting in line (LINE_WAITING)
  lineWaiting: process.env.LINE_WAITING === 'true',
  lineStatuses: new Set(
    (process.env.LINE_STATUSES || '503')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean)
  ),
  lineBaseDelayMs: Number(process.env.LINE_BASE_DELAY_MS || 10_000),
  lineMaxDelayMs: Number(process.env.LINE_MAX_DELAY_MS || 60_000),
  lineMaxWaitMs: Number(process.env.LINE_MAX_WAIT_MS || 300_000),
  lineStaggerMs: Number(process.env.LINE_STAGGER_MS || 1_500),
  lineKeepaliveMs: Number(process.env.LINE_KEEPALIVE_MS || 15_000),

  defaultTemperature: optionalNumber('DEFAULT_TEMPERATURE'),
  defaultTopP: optionalNumber('DEFAULT_TOP_P'),
  defaultFrequencyPenalty: optionalNumber('DEFAULT_FREQUENCY_PENALTY'),
  defaultPresencePenalty: optionalNumber('DEFAULT_PRESENCE_PENALTY'),
  defaultMaxTokens: optionalNumber('DEFAULT_MAX_TOKENS') ?? 12000,
  maxTokensCap: optionalNumber('MAX_TOKENS_CAP'),

  enableThinking: process.env.ENABLE_THINKING === 'true',
  reasoningEffort: process.env.REASONING_EFFORT,
  showReasoning: process.env.SHOW_REASONING === 'true',

  enablePrefill: process.env.ENABLE_PREFILL === 'true',
  enableOocTrick: process.env.ENABLE_OOC_TRICK === 'true',
  enableBrailleTrick: process.env.ENABLE_BRAILLE_TRICK === 'true',
  enableNoAss: process.env.ENABLE_NOASS === 'true',
  enableGoogleSearch: process.env.ENABLE_GOOGLE_SEARCH === 'true',

  readImage: process.env.READ_IMAGE === 'true',
  readImageHosts: (process.env.READ_IMAGE_HOSTS || 'ella.janitorai.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  readImagePathPrefix: process.env.READ_IMAGE_PATH_PREFIX || '/media-approved/',
  readImageMax: Number(process.env.READ_IMAGE_MAX || 4),
  readImageMaxBytes: Number(process.env.READ_IMAGE_MAX_BYTES || 5 * 1024 * 1024),
  readImageTimeoutMs: Number(process.env.READ_IMAGE_TIMEOUT_MS || 10_000),
  readImageCacheBytes: Number(process.env.READ_IMAGE_CACHE_BYTES || 50 * 1024 * 1024),

  responseLength: normalizeChoice(process.env.RESPONSE_LENGTH, RESPONSE_LENGTHS),
  noAism: process.env.NO_AISM === 'true',
  forceMarkdown: process.env.FORCE_MARKDOWN === 'true',
  narrationMode: normalizeChoice(process.env.NARRATION_MODE, NARRATION_MODES),
  livingWorld: process.env.LIVING_WORLD === 'true',
  realTexting: process.env.REAL_TEXTING === 'true',
  dialogueRatio: normalizeChoice(process.env.DIALOGUE_RATIO, DIALOGUE_RATIOS),
  pacing: normalizeChoice(process.env.PACING, PACINGS),
  varyOpeners: process.env.VARY_OPENERS === 'true',
  realism: process.env.REALISM === 'true',
  continuity: process.env.CONTINUITY === 'true',
  proactive: process.env.PROACTIVE === 'true',
};
