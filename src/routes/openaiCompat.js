import express from 'express';
import { config } from '../config.js';
import { applyGenerationDefaults, resolveThinkingConfig, extractParts } from '../lib/generationDefaults.js';
import { extractInlineCommands, applyInlineCommands } from '../lib/inlineCommands.js';
import { applyRoleplayTricks, friendlyErrorMessage } from '../lib/roleplayTricks.js';
import { fetchWithRetry } from '../lib/upstreamFetch.js';
import { getCandidateKeys, isKeyExhaustionError, markKeyExhausted, markKeySuccess, maskKey } from '../lib/keyManager.js';
import { logGeminiRequest } from '../lib/requestLog.js';
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


function flattenContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
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
  // frequency_penalty: discourages a token proportional to how many times
  // it's already appeared. presence_penalty: flat discouragement for any
  // token that's appeared at all, regardless of count — this is what most
  // roleplay frontends (Janitor included) label "Repetition Penalty".
  // Gemini's generationConfig takes both directly under these names.
  if (body.frequency_penalty !== undefined) cfg.frequencyPenalty = body.frequency_penalty;
  if (body.presence_penalty !== undefined) cfg.presencePenalty = body.presence_penalty;
  if (body.stop !== undefined) {
    cfg.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  // seed is intentionally dropped — never forwarded to Gemini, regardless
  // of what the client sends. A pinned seed makes Gemini reproduce
  // (near-)identical output for the same context on every call, which
  // flattens variety on regenerates/swipes instead of helping.
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

router.post('/v1beta/openai/chat/completions', async (req, res, next) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const startedAt = Date.now();
  // Hoisted above the try (rather than left as const inside it) so the
  // catch block — the timeout/AbortError case — still knows what model and
  // stream mode the log line is for.
  let model = 'unknown';
  let wantsStream = false;

  try {
    const body = applyGenerationDefaults(req.body || {});
    model = body.model || 'gemini-flash-latest';

    // In-chat <ENABLE_THINKING=...>/<REASONING_EFFORT=...>/<SHOW_REASONING=...>
    // tags, wherever they show up in the incoming messages (typically
    // Janitor's own "Custom Prompt" field) — see lib/inlineCommands.js.
    // Tags are stripped from the text before anything else touches it.
    const { commands, messages: taggedMessages } = extractInlineCommands(body.messages || []);
    const { cfg: effectiveConfig, body: effectiveBody } = applyInlineCommands(config, body, commands);

    const messages = applyRoleplayTricks(taggedMessages, effectiveConfig);
    const { contents } = toGeminiContents(messages);

    const generationConfig = toGenerationConfig(body);
    const thinkingConfig = resolveThinkingConfig(model, effectiveBody, effectiveConfig);
    if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

    const systemInstruction = buildSystemInstruction(config);
    const geminiBody = {
      contents,
      generationConfig,
      safetySettings: buildSafetySettings(config),
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(config.enableGoogleSearch ? { tools: [{ googleSearch: {} }] } : {}),
    };

    wantsStream = Boolean(body.stream);
    const method = wantsStream ? 'streamGenerateContent' : 'generateContent';
    const targetUrl = new URL(
      `/v1beta/models/${model}:${method}${wantsStream ? '?alt=sse' : ''}`,
      config.geminiBaseUrl
    );

    const headers = new Headers({ 'content-type': 'application/json' });

    // Multi-key rotation (see lib/keyManager.js). With only one key
    // configured this is a single iteration — same request as before.
    // getCandidateKeys reorders req.geminiApiKeys itself (sticky "last
    // known good" key first, exhausted ones pushed to the back), so we
    // just walk the list it hands back.
    const keyList = req.geminiApiKeys?.length ? req.geminiApiKeys : req.geminiApiKey ? [req.geminiApiKey] : [];
    const candidateKeys = getCandidateKeys(keyList);

    if (candidateKeys.length === 0) {
      clearTimeout(timeoutId);
      return res.status(401).json({ error: { message: 'No Gemini API key available for this request.' } });
    }

    let upstream;
    let errText;
    let parsedError;

    for (let attempt = 0; attempt < candidateKeys.length; attempt++) {
      const key = candidateKeys[attempt];
      headers.set('x-goog-api-key', key);

      upstream = await fetchWithRetry(
        targetUrl,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(geminiBody),
          signal: controller.signal,
        },
        { attempts: config.retryAttempts, baseDelayMs: config.retryBaseDelayMs }
      );

      if (upstream.ok) {
        markKeySuccess(key, keyList);
        break;
      }

      errText = await upstream.text();
      parsedError = undefined;
      try {
        parsedError = JSON.parse(errText)?.error;
      } catch {
        // errText wasn't JSON — use it as-is further down.
      }

      const isLastCandidate = attempt === candidateKeys.length - 1;
      if (!isLastCandidate && isKeyExhaustionError(upstream.status, parsedError, errText)) {
        // A truly dead/revoked key (UNAUTHENTICATED / "API key not
        // valid") is never coming back on its own — leave it out of
        // rotation far longer than a merely rate-limited/quota-exhausted
        // one, which resets on its own before long.
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
    clearTimeout(timeoutId);

    if (!upstream.ok) {
      const message = friendlyErrorMessage(parsedError, parsedError?.message || errText, model);
      logGeminiRequest({
        model,
        stream: wantsStream,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      return res.status(upstream.status).json({ error: { message } });
    }

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

      // Empty + policy/safety block used to come back as HTTP 200 with
      // finish_reason "stop" and blank content — Janitor just showed an
      // empty swipe. Surface it as a real error instead.
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

    // Streaming: re-emit Gemini's native SSE chunks as OpenAI-style chunks.
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');

    let buffer = '';
    // Thinking spans multiple SSE chunks, so opening/closing the tag inside
    // the per-chunk handler (the previous behavior) produced one
    // <think>...</think> pair PER CHUNK instead of one pair for the whole
    // reasoning block. Tracking open/closed state across the whole stream
    // fixes that: the tag opens exactly once, right before the first
    // reasoning token, and closes exactly once, right before the first
    // visible content token (or right before finish, if the model finished
    // without ever producing visible content).
    let thinkOpen = false;
    let thinkClosed = false;
    // Gemini includes usageMetadata on streamed chunks with running totals —
    // overwriting on every chunk means whatever's here when the stream ends
    // is the final, complete count.
    let usage;
    // Gemini's own finishReason (MAX_TOKENS / SAFETY / RECITATION / STOP),
    // captured from whichever chunk carries it — normally only the last one.
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

    // Handles one raw line from the SSE stream. Pulled out to a named
    // function because it needs to run in two places: once per complete
    // line as they arrive, and ONE MORE TIME after the read loop ends, on
    // whatever's left in `buffer` — see the comment above the loop for why
    // that second call matters.
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
        // Skip a malformed chunk rather than crashing the whole stream.
      }
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    req.on('close', () => reader.cancel().catch(() => {}));

    // A `read()` that returns done:true is only guaranteed to mean "no more
    // BYTES are coming" — it says nothing about whether `buffer` still holds
    // a complete-but-unterminated line. SSE events are meant to end with a
    // blank line, but if the upstream connection closes right after the
    // final event's data (no trailing newline flushed before the socket
    // closes — which is exactly the kind of thing an abrupt mid-stream
    // disconnect causes), that whole trailing chunk sat in `buffer`,
    // waiting for a newline that was never coming, and previously got
    // silently discarded the moment the loop exited. That chunk is very
    // often the one carrying finishReason — which is exactly why a cutoff
    // stream could show a completely empty `finishReason=` in the logs:
    // not because Gemini didn't say why, but because we never looked.
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
    // Flush the decoder (in case a multi-byte UTF-8 character was split
    // across the last two reads) and process whatever's left in `buffer` —
    // the fix described above.
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
      // If the stream ended and we STILL never saw a finishReason (even
      // after the flush above), that's worth knowing on its own — it means
      // the upstream connection was cut before Gemini ever sent a proper
      // terminal event, rather than Gemini deciding to stop for a reason we
      // just failed to log. Distinct from every real Gemini finishReason
      // value, so it's unambiguous in the logs.
      finishReason: lastFinishReason ?? lastPromptBlockReason ?? 'STREAM_CLOSED_WITHOUT_FINISH_REASON',
      promptBlockReason: lastPromptBlockReason,
      promptTokens: usage?.promptTokenCount,
      completionTokens: usage?.candidatesTokenCount,
      totalTokens: usage?.totalTokenCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      logGeminiRequest({
        model,
        stream: wantsStream,
        status: 504,
        durationMs: Date.now() - startedAt,
        error: 'Upstream Gemini request timed out.',
      });
      return res.status(504).json({ error: { message: 'Upstream Gemini request timed out.' } });
    }
    next(err);
  }
});

export default router;
