import express from 'express';
import { config } from '../config.js';
import { applyGenerationDefaults, resolveThinkingConfig, extractParts } from '../lib/generationDefaults.js';
import { extractInlineCommands, applyInlineCommands } from '../lib/inlineCommands.js';
import { applyRoleplayTricks, friendlyErrorMessage } from '../lib/roleplayTricks.js';
import { buildRoleplayDirectives, mergeSystemInstruction } from '../lib/roleplayPrompts.js';
import { fetchWithRetry } from '../lib/upstreamFetch.js';
import { createLineQueue, LineTimeoutError } from '../lib/lineQueue.js';
import { getCandidateKeys, isKeyExhaustionError, markKeyExhausted, markKeySuccess, maskKey } from '../lib/keyManager.js';
import { logGeminiRequest } from '../lib/requestLog.js';
import { attachImages } from '../lib/imageReader.js';
import { getVertexToken } from '../lib/vertexAuth.js';
import {
  buildSafetySettings,
  buildSystemInstruction,
  finishReasonToOpenAI,
  isContentFilterReason,
  resolveBlockReason,
  blockedReasonMessage,
  contentFilterError,
} from '../lib/geminiSafety.js';

const router = express.Router();

const lineQueue = createLineQueue({
  baseDelayMs: config.lineBaseDelayMs,
  maxDelayMs: config.lineMaxDelayMs,
  staggerMs: config.lineStaggerMs,
});

function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        if (part?.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (typeof url === 'string' && url) return `![image](${url})`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function hasVisibleText(content, reasoning) {
  return Boolean(String(content || '').trim() || String(reasoning || '').trim());
}

function toGeminiContents(messages = []) {
  let i = 0;
  const headerParts = [];
  while (i < messages.length && messages[i].role === 'system') {
    const text = flattenContent(messages[i].content);
    if (text) headerParts.push(text);
    i++;
  }

  const turns = [];
  for (; i < messages.length; i++) {
    const msg = messages[i];
    const text = flattenContent(msg.content);

    if (msg.role === 'system') {
      turns.push({ role: 'user', parts: [{ text: `[System note: ${text}]` }] });
      continue;
    }

    const role = msg.role === 'assistant' ? 'model' : 'user';
    const prefix = msg.name ? `${msg.name}: ` : '';
    turns.push({ role, parts: [{ text: prefix + text }] });
  }

  if (headerParts.length) {
    turns.unshift({ role: 'model', parts: [{ text: headerParts.join('\n\n') }] });
  }

  const contents = [];
  for (const turn of turns) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts[0].text += `\n\n${turn.parts[0].text}`;
    } else {
      contents.push(turn);
    }
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: '.' }] });
  } else if (contents[contents.length - 1].role !== 'user') {
    contents.push({ role: 'user', parts: [{ text: '.' }] });
  }

  return { contents };
}

function toGenerationConfig(body) {
  const cfg = {};
  if (body.temperature !== undefined) cfg.temperature = body.temperature;
  if (body.top_p !== undefined) cfg.topP = body.top_p;
  if (body.top_k !== undefined) cfg.topK = body.top_k;
  if (body.max_tokens !== undefined) cfg.maxOutputTokens = body.max_tokens;
  if (body.frequency_penalty !== undefined) cfg.frequencyPenalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) cfg.presencePenalty = body.presence_penalty;
  if (body.stop !== undefined) {
    cfg.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (body.n !== undefined) cfg.candidateCount = body.n;
  return cfg;
}

function openaiChunk({ completionId, createdTs, model, deltaText, finishReason }) {
  return `data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created: createdTs,
    model,
    choices: [
      {
        index: 0,
        delta: deltaText ? { content: deltaText } : {},
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

// Handlers for both standard OpenAI paths and Gemini beta path
const COMPLETION_ROUTES = [
  '/v1beta/openai/chat/completions',
  '/v1/chat/completions',
  '/chat/completions',
];

router.get(['/v1/models', '/models'], (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'gemini-4-argon', object: 'model', owned_by: 'google' },
      { id: 'gemini-2.5-flash', object: 'model', owned_by: 'google' },
      { id: 'gemini-2.5-pro', object: 'model', owned_by: 'google' },
    ],
  });
});

router.post(COMPLETION_ROUTES, async (req, res, next) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = Date.now();
  let model = 'unknown';
  let wantsStream = false;
  let keepAlive;
  const stopKeepAlive = () => {
    clearInterval(keepAlive);
    keepAlive = undefined;
  };

  function sendError(status, message) {
    stopKeepAlive();
    if (res.destroyed) return;
    if (!res.headersSent) return res.status(status).json({ error: { message } });
    res.write(
      openaiChunk({
        completionId: `chatcmpl-${Date.now()}`,
        createdTs: Math.floor(Date.now() / 1000),
        model,
        deltaText: `[Proxy] ${message}`,
        finishReason: 'stop',
      })
    );
    res.write('data: [DONE]\n\n');
    res.end();
  }

  try {
    const body = applyGenerationDefaults(req.body || {});
    model = body.model || 'gemini-flash-latest';

    const { commands, messages: taggedMessages } = extractInlineCommands(body.messages || []);
    const { cfg: effectiveConfig, body: effectiveBody } = applyInlineCommands(config, body, commands);

    const messages = applyRoleplayTricks(taggedMessages, effectiveConfig);
    const { contents: textContents } = toGeminiContents(messages);

    let contents = textContents;
    if (effectiveConfig.readImage) {
      const result = await attachImages(textContents, effectiveConfig);
      contents = result.contents;
      if (result.stats.found) {
        const { found, attached, failed, skipped } = result.stats;
        console.log(`[read_image] found=${found} attached=${attached} failed=${failed} skipped=${skipped}`);
      }
    }

    const generationConfig = toGenerationConfig(body);
    const thinkingConfig = resolveThinkingConfig(model, effectiveBody, effectiveConfig);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const systemInstruction = mergeSystemInstruction(
      buildSystemInstruction(config),
      buildRoleplayDirectives(effectiveConfig)
    );
    const geminiBody = {
      contents,
      generationConfig,
      safetySettings: buildSafetySettings(config),
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(config.enableGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    };

    wantsStream = Boolean(body.stream);
    const method = wantsStream ? 'streamGenerateContent' : 'generateContent';

    // Route to Vertex AI if GCP_SERVICE_ACCOUNT_KEY is configured OR model is an Argon model
    const isVertex = Boolean(config.gcpServiceAccount) || model.includes('argon');

    let targetUrl;
    const headers = new Headers({ 'content-type': 'application/json' });

    if (isVertex && config.gcpServiceAccount) {
      const sa =
        typeof config.gcpServiceAccount === 'string'
          ? JSON.parse(config.gcpServiceAccount)
          : config.gcpServiceAccount;

      const projectId = sa.project_id;
      const location = config.gcpRegion || 'global';

      targetUrl = new URL(
        `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:${method}${wantsStream ? '?alt=sse' : ''}`
      );

      const token = await getVertexToken(sa);
      headers.set('authorization', `Bearer ${token}`);
    } else {
      targetUrl = new URL(
        `/v1beta/models/${model}:${method}${wantsStream ? '?alt=sse' : ''}`,
        config.geminiBaseUrl
      );
    }

    const keyList = req.geminiApiKeys?.length ? req.geminiApiKeys : req.geminiApiKey ? [req.geminiApiKey] : [];
    const candidateKeys = isVertex ? ['vertex-token'] : getCandidateKeys(keyList);

    if (!isVertex && candidateKeys.length === 0) {
      clearTimeout(timeoutId);
      return res.status(401).json({ error: { message: 'No Gemini API key available for this request.' } });
    }

    let upstream;
    let errText;
    let parsedError;

    const lineOn = config.lineWaiting;
    const lineDeadline = Date.now() + config.lineMaxWaitMs;
    let lineTurns = 0;
    let lineGaveUp = false;

    if (lineOn) {
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
    }

    function startKeepAlive() {
      if (!wantsStream || keepAlive || res.destroyed) return;
      if (!res.headersSent) {
        res.setHeader('content-type', 'text/event-stream');
        res.setHeader('cache-control', 'no-cache');
        res.setHeader('connection', 'keep-alive');
        res.flushHeaders();
      }
      res.write(': waiting in line\n\n');
      keepAlive = setInterval(() => res.write(': waiting in line\n\n'), config.lineKeepaliveMs);
    }

    while (true) {
      let ticket;
      if (lineOn) {
        if (lineTurns > 0 || lineQueue.snapshot(model).failures > 0) startKeepAlive();
        try {
          ticket = await lineQueue.joinLine(model, {
            signal: controller.signal,
            deadline: lineDeadline,
            front: lineTurns > 0,
          });
        } catch (err) {
          if (err instanceof LineTimeoutError) {
            lineGaveUp = true;
            break;
          }
          throw err;
        }
        lineTurns++;
        if (ticket.waitedMs > 0) {
          console.log(`[line] ${model} turn #${lineTurns} after ${Math.round(ticket.waitedMs / 1000)}s in line`);
        }
      }

      try {
        for (let attempt = 0; attempt < candidateKeys.length; attempt++) {
          const key = candidateKeys[attempt];
          if (!isVertex) {
            headers.set('x-goog-api-key', key);
          }

          upstream = await fetchWithRetry(
            targetUrl,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(geminiBody),
              signal: controller.signal,
            },
            { attempts: lineOn ? 1 : config.retryAttempts, baseDelayMs: config.retryBaseDelayMs }
          );

          if (upstream.ok) {
            if (!isVertex) markKeySuccess(key, keyList);
            break;
          }

          errText = await upstream.text();
          parsedError = undefined;
          try {
            parsedError = JSON.parse(errText)?.error;
          } catch {
            // Not JSON
          }

          const isLastCandidate = attempt === candidateKeys.length - 1;
          if (!isVertex && !isLastCandidate && isKeyExhaustionError(upstream.status, parsedError, errText)) {
            const looksPermanentlyDead =
              parsedError?.status === 'UNAUTHENTICATED' ||
              /api key not valid|api_key_invalid|api key expired/i.test(parsedError?.message || errText || '');
            const cooldownMs = looksPermanentlyDead ? config.keyInvalidCooldownMs : config.keyCooldownMs;

            markKeyExhausted(key, cooldownMs, parsedError?.message || errText, keyList);
            console.warn(`[gemini] key ${maskKey(key)} failed (status=${upstream.status}), rotating to next key`);
            continue;
          }

          break;
        }
      } catch (err) {
        ticket?.release();
        throw err;
      }

      if (lineOn) {
        if (config.lineStatuses.has(upstream.status)) {
          ticket.overloaded();
          const { waiting, nextInMs } = lineQueue.snapshot(model);
          console.warn(
            `[line] ${model} got ${upstream.status}; waiting in line (next try in ~${Math.round(nextInMs / 1000)}s, ${waiting} waiting)`
          );
          continue;
        }
        ticket.success();
      }
      break;
    }
    clearTimeout(timeoutId);

    if (lineGaveUp) {
      const waitedS = Math.round((Date.now() - startedAt) / 1000);
      const message = `Gemini model "${model}" is still overloaded after waiting ${waitedS}s in line. Try again in a bit.`;
      logGeminiRequest({ model, stream: wantsStream, status: 503, durationMs: Date.now() - startedAt, error: message });
      return sendError(503, message);
    }

    if (!upstream.ok) {
      const message = friendlyErrorMessage(parsedError, parsedError?.message || errText, model);
      logGeminiRequest({
        model,
        stream: wantsStream,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return sendError(upstream.status, message);
    }
    stopKeepAlive();

    const completionId = `chatcmpl-${Date.now()}`;
    const createdTs = Math.floor(Date.now() / 1000);

    if (!wantsStream) {
      const data = await upstream.json();
      const candidate = data.candidates?.[0];
      const { content, reasoning } = extractParts(candidate);
      const finalContent = reasoning ? `<think>${reasoning}</think>\n\n${content}` : content;
      const usage = {
        prompt_tokens: data.usageMetadata?.promptTokenCount || 0,
        completion_tokens: data.usageMetadata?.candidatesTokenCount || 0,
        total_tokens: data.usageMetadata?.totalTokenCount || 0,
      };
      const promptBlockReason = data.promptFeedback?.blockReason;
      const finishReason = candidate?.finishReason;
      const blockReason = resolveBlockReason(data, candidate);

      logGeminiRequest({
        model,
        stream: false,
        status: 200,
        finishReason: finishReason ?? promptBlockReason,
        promptBlockReason,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        durationMs: Date.now() - startedAt,
      });

      if (!hasVisibleText(content, reasoning) && isContentFilterReason(blockReason)) {
        return res.status(400).json(contentFilterError(blockReason));
      }

      return res.json({
        id: completionId,
        object: 'chat.completion',
        created: createdTs,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: finalContent,
            },
            finish_reason: finishReasonToOpenAI(finishReason),
          },
        ],
        usage,
      });
    }

    // Streaming response
    if (!res.headersSent) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('cache-control', 'no-cache');
      res.setHeader('connection', 'keep-alive');
    }

    let buffer = '';
    let thinkOpen = false;
    let thinkClosed = false;
    let usage;
    let lastFinishReason;
    let lastPromptBlockReason;
    let hadVisibleContent = false;

    function buildDelta(content, reasoning) {
      let text = '';
      if (reasoning) {
        if (!thinkOpen) {
          text += '<think>';
          thinkOpen = true;
        }
        text += reasoning;
      }
      if (content) {
        if (thinkOpen && !thinkClosed) {
          text += '</think>';
          thinkClosed = true;
        }
        text += content;
      }
      return text;
    }

    function processSseLine(line) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      try {
        const parsed = JSON.parse(payload);
        const candidate = parsed.candidates?.[0];
        const { content, reasoning } = extractParts(candidate);
        if (hasVisibleText(content, reasoning)) hadVisibleContent = true;
        const finishReason = candidate?.finishReason
          ? finishReasonToOpenAI(candidate.finishReason)
          : null;
        if (candidate?.finishReason) lastFinishReason = candidate.finishReason;
        if (parsed.promptFeedback?.blockReason) {
          lastPromptBlockReason = parsed.promptFeedback.blockReason;
        }
        if (parsed.usageMetadata) usage = parsed.usageMetadata;

        let deltaText = buildDelta(content, reasoning);
        if (finishReason && thinkOpen && !thinkClosed) {
          deltaText += '</think>';
          thinkClosed = true;
        }

        res.write(
          openaiChunk({
            completionId,
            createdTs,
            model,
            deltaText,
            finishReason,
          })
        );
      } catch {
        // Skip malformed chunk
      }
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    req.on('close', () => reader.cancel().catch(() => {}));

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        processSseLine(line);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      processSseLine(buffer);
    }

    const streamBlock = lastPromptBlockReason || lastFinishReason;
    if (!hadVisibleContent && isContentFilterReason(streamBlock)) {
      const notice = `[Proxy] ${blockedReasonMessage(streamBlock)}`;
      res.write(
        openaiChunk({
          completionId,
          createdTs,
          model,
          deltaText: notice,
          finishReason: 'content_filter',
        })
      );
    }

    res.write('data: [DONE]\n\n');
    res.end();
    logGeminiRequest({
      model,
      stream: true,
      status: 200,
      finishReason: lastFinishReason ?? lastPromptBlockReason ?? 'STREAM_CLOSED_WITHOUT_FINISH_REASON',
      promptBlockReason: lastPromptBlockReason,
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount,
      totalTokens: usage?.totalTokenCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    stopKeepAlive();
    if (res.destroyed) return;
    if (err.name === 'AbortError') {
      logGeminiRequest({
        model,
        stream: wantsStream,
        status: 504,
        durationMs: Date.now() - startedAt,
        error: 'Upstream Gemini request timed out.',
      });
      return sendError(504, 'Upstream Gemini request timed out.');
    }
    next(err);
  }
});

export default router;
