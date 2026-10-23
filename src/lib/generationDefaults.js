import { config } from '../config.js';

// Applies config-level generation defaults (temperature / top_p /
// max_tokens / frequency_penalty / presence_penalty) to an OpenAI-SHAPED
// request body, but only for fields the client didn't already set explicitly.
export function applyGenerationDefaults(body) {
  if (!body || typeof body !== 'object') return body;
  const result = { ...body };

  if (result.temperature === undefined && config.defaultTemperature !== undefined) {
    result.temperature = config.defaultTemperature;
  }
  if (result.top_p === undefined && config.defaultTopP !== undefined) {
    result.top_p = config.defaultTopP;
  }
  if (result.frequency_penalty === undefined && config.defaultFrequencyPenalty !== undefined) {
    result.frequency_penalty = config.defaultFrequencyPenalty;
  }
  if (result.presence_penalty === undefined && config.defaultPresencePenalty !== undefined) {
    result.presence_penalty = config.defaultPresencePenalty;
  }
  if (result.max_tokens === undefined && config.defaultMaxTokens !== undefined) {
    result.max_tokens = config.defaultMaxTokens;
  }
  if (config.maxTokensCap !== undefined && typeof result.max_tokens === 'number') {
    result.max_tokens = Math.min(result.max_tokens, config.maxTokensCap);
  }
  return result;
}

// Models that require thinkingLevel ('low'|'medium'|'high') rather than a numeric thinkingBudget:
// Gemini 3.x, Gemini 4.x, and Argon series.
const THINKING_LEVEL_MODEL = /^gemini-([3-9]|\d{2,})(\.\d+)?(-|$)|argon/i;

export function isThinkingLevelModel(model) {
  return typeof model === 'string' && THINKING_LEVEL_MODEL.test(model);
}

// Backward-compatibility alias
export const isGemini3Model = isThinkingLevelModel;

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

// Approximate token budget for older Gemini 2.5 models
const EFFORT_TO_BUDGET = {
  minimal: 0,
  low: 2048,
  medium: 8192,
  high: 24576,
};

function budgetToLevel(budget) {
  if (budget <= 0) return 'low';
  if (budget <= 4096) return 'low';
  if (budget <= 16384) return 'medium';
  return 'high';
}

export function resolveThinkingConfig(model, body, cfg = config) {
  const requestedLevel = body?.reasoning_effort ?? body?.thinking_level;
  const requestedBudget = body?.thinking_budget;
  const requestedIncludeThoughts = body?.include_thoughts;

  let level = THINKING_LEVELS.has(requestedLevel)
    ? requestedLevel
    : cfg.enableThinking
    ? cfg.reasoningEffort || 'low'
    : undefined;

  const includeThoughts =
    requestedIncludeThoughts !== undefined ? Boolean(requestedIncludeThoughts) : cfg.showReasoning;

  const thinkingConfig = {};
  const needsLevel = isThinkingLevelModel(model);

  if (needsLevel) {
    if (level || requestedBudget !== undefined) {
      let effectiveLevel = level || budgetToLevel(requestedBudget);
      // Models like 3.7+, 4.x, and Argon reject 'minimal' with a 400 error — use 'low' as floor
      if (effectiveLevel === 'minimal' && /^gemini-(3\.[7-9]|4|argon)|\bargon\b/i.test(model)) {
        effectiveLevel = 'low';
      }
      thinkingConfig.thinkingLevel = effectiveLevel;
    }
  } else {
    if (requestedBudget !== undefined) {
      thinkingConfig.thinkingBudget = requestedBudget;
    } else if (level) {
      thinkingConfig.thinkingBudget = EFFORT_TO_BUDGET[level] ?? -1;
    }
  }

  // Always enable thoughts extraction if requested or configured
  if (includeThoughts) {
    thinkingConfig.includeThoughts = true;
  }

  return Object.keys(thinkingConfig).length ? thinkingConfig : undefined;
}

export function extractParts(candidate) {
  const parts = candidate?.content?.parts || [];
  let content = '';
  let reasoning = '';
  for (const part of parts) {
    if (!part.text) continue;
    if (part.thought) reasoning += part.text;
    else content += part.text;
  }
  return { content, reasoning };
}
