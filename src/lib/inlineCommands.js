// In-chat control tags for the Gemini "thinking" settings and the roleplay
// style prompts — lets you flip them per character/chat straight from
// Janitor's own "Custom Prompt" (or jailbreak/persona) field, instead of
// editing Railway variables and redeploying every time.
//
// Janitor resends the whole custom prompt as part of every request, so a
// tag left in there behaves like a standing setting for that chat: it
// applies on every message until you edit the prompt and delete the tag,
// at which point the proxy just falls back to whatever's configured in
// Railway again.
//
// Recognized tags — case-insensitive, `=` or `:` both work as the
// separator, matched wherever they appear across the whole message list:
//
//   <ENABLE_THINKING=true|false>
//   <REASONING_EFFORT=minimal|low|medium|high>
//   <SHOW_REASONING=true|false>
//   <THINKING_BUDGET=1234>     (advanced: raw token budget, any model)
//
//   <RESPONSE_LENGTH=banter|short|medium|long|novel>
//   <NO_AISM=true|false>
//   <FORCE_MARKDOWN=true|false>
//   <NARRATION_MODE=simple|professional>
//   <LIVING_WORLD=true|false>
//   <REAL_TEXTING=true|false>
//   <DIALOGUE_RATIO=low|medium|high>
//   <PACING=slow|normal|fast>
//   <VARY_OPENERS=true|false>
//   <REALISM=true|false>
//   <CONTINUITY=true|false>
//   <PROACTIVE=true|false>
//
// Every matched tag (plus the whitespace/newline immediately around it) is
// removed from the message text before anything else touches it — none of
// this is meant to be visible to the model.

import { RESPONSE_LENGTHS, NARRATION_MODES, DIALOGUE_RATIOS, PACINGS } from './roleplayPrompts.js';

const BOOL_VALUES = { true: true, on: true, 1: true, false: false, off: false, 0: false };
const BOOL_ALT = 'true|false|on|off|1|0';

const boolParse = (raw) => BOOL_VALUES[raw.toLowerCase()];
const lowerParse = (raw) => raw.toLowerCase();

// Each pattern eats its own trailing same-line whitespace plus one trailing
// newline (so a tag on its own line leaves no blank line behind) but
// deliberately does NOT eat anything before the "<" — a tag sitting
// mid-sentence ("the door <TAG> opens") collapses to a single space instead
// of gluing the surrounding words together.
function tagPattern(name, valueAlt) {
  return new RegExp(`<\\s*${name}\\s*[:=]\\s*(${valueAlt})\\s*>[ \\t]*\\n?`, 'gi');
}

const TAG_DEFS = [
  { key: 'enableThinking', pattern: tagPattern('ENABLE_THINKING', BOOL_ALT), parse: boolParse },
  { key: 'reasoningEffort', pattern: tagPattern('REASONING_EFFORT', 'minimal|low|medium|high'), parse: lowerParse },
  { key: 'showReasoning', pattern: tagPattern('SHOW_REASONING', BOOL_ALT), parse: boolParse },
  { key: 'thinkingBudget', pattern: tagPattern('THINKING_BUDGET', '-?\\d+'), parse: (raw) => Number(raw) },

  { key: 'responseLength', pattern: tagPattern('RESPONSE_LENGTH', RESPONSE_LENGTHS.join('|')), parse: lowerParse },
  { key: 'noAism', pattern: tagPattern('NO_AISM', BOOL_ALT), parse: boolParse },
  { key: 'forceMarkdown', pattern: tagPattern('FORCE_MARKDOWN', BOOL_ALT), parse: boolParse },
  { key: 'narrationMode', pattern: tagPattern('NARRATION_MODE', NARRATION_MODES.join('|')), parse: lowerParse },
  { key: 'livingWorld', pattern: tagPattern('LIVING_WORLD', BOOL_ALT), parse: boolParse },
  { key: 'realTexting', pattern: tagPattern('REAL_TEXTING', BOOL_ALT), parse: boolParse },
  { key: 'dialogueRatio', pattern: tagPattern('DIALOGUE_RATIO', DIALOGUE_RATIOS.join('|')), parse: lowerParse },
  { key: 'pacing', pattern: tagPattern('PACING', PACINGS.join('|')), parse: lowerParse },
  { key: 'varyOpeners', pattern: tagPattern('VARY_OPENERS', BOOL_ALT), parse: boolParse },
  { key: 'realism', pattern: tagPattern('REALISM', BOOL_ALT), parse: boolParse },
  { key: 'continuity', pattern: tagPattern('CONTINUITY', BOOL_ALT), parse: boolParse },
  { key: 'proactive', pattern: tagPattern('PROACTIVE', BOOL_ALT), parse: boolParse },
];

// Keys that map straight onto cfg fields of the same name.
const CFG_KEYS = [
  'enableThinking',
  'responseLength',
  'noAism',
  'forceMarkdown',
  'narrationMode',
  'livingWorld',
  'realTexting',
  'dialogueRatio',
  'pacing',
  'varyOpeners',
  'realism',
  'continuity',
  'proactive',
];

// Runs every tag pattern over one string, recording the LAST value seen for
// each key and stripping every match out of the text.
function stripFromText(text, commands) {
  let result = text;
  for (const { key, pattern, parse } of TAG_DEFS) {
    result = result.replace(pattern, (_match, raw) => {
      commands[key] = parse(raw);
      return '';
    });
  }
  return result;
}

// Scans every message's content for the tags above, strips them out, and
// returns both the parsed commands and a cleaned copy of the message list.
// Handles both plain string content and OpenAI-style array content.
// Messages with nothing to strip are returned unchanged (same object).
export function extractInlineCommands(messages = []) {
  const commands = {};

  const cleaned = messages.map((msg) => {
    if (!msg) return msg;

    if (typeof msg.content === 'string') {
      const text = stripFromText(msg.content, commands);
      return text === msg.content ? msg : { ...msg, content: text };
    }

    if (Array.isArray(msg.content)) {
      let changed = false;
      const parts = msg.content.map((part) => {
        if (part && typeof part.text === 'string') {
          const text = stripFromText(part.text, commands);
          if (text !== part.text) {
            changed = true;
            return { ...part, text };
          }
        }
        return part;
      });
      return changed ? { ...msg, content: parts } : msg;
    }

    return msg;
  });

  return { commands, messages: cleaned };
}

// Folds parsed inline commands into a per-request cfg/body pair:
//
// - ENABLE_THINKING and all the roleplay style settings live on cfg, so
//   they're applied to a shallow-cloned `cfg`. If nothing needs overriding,
//   the original cfg object is returned untouched.
// - REASONING_EFFORT / SHOW_REASONING / THINKING_BUDGET are applied to a
//   shallow-cloned `body`, reusing the per-request override fields
//   resolveThinkingConfig() already understands and already treats as
//   taking precedence over cfg.
export function applyInlineCommands(cfg, body, commands) {
  const overrides = {};
  for (const key of CFG_KEYS) {
    if (commands[key] !== undefined) overrides[key] = commands[key];
  }
  const effectiveCfg = Object.keys(overrides).length ? { ...cfg, ...overrides } : cfg;

  const effectiveBody = { ...body };
  if (commands.reasoningEffort !== undefined) {
    effectiveBody.thinking_level = commands.reasoningEffort;
  }
  if (commands.thinkingBudget !== undefined) {
    effectiveBody.thinking_budget = commands.thinkingBudget;
  }
  if (commands.showReasoning !== undefined) {
    effectiveBody.include_thoughts = commands.showReasoning;
  }

  return { cfg: effectiveCfg, body: effectiveBody };
}
