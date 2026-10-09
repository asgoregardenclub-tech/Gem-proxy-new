// Toggleable roleplay-quality prompts. Each setting adds a short directive
// block to Gemini's systemInstruction. Everything is OFF/unset by default,
// and every one can be flipped per-chat with an inline tag (see
// lib/inlineCommands.js), e.g. <RESPONSE_LENGTH=long> in Janitor's Custom
// Prompt field.
//
// Settings (all live on cfg, same shape as config.js):
//   responseLength : 'banter' | 'short' | 'medium' | 'long' | 'novel'
//   noAism         : boolean
//   forceMarkdown  : boolean
//   narrationMode  : 'simple' | 'professional'
//   livingWorld    : boolean
//   realTexting    : boolean

export const RESPONSE_LENGTHS = ['banter', 'short', 'medium', 'long', 'novel'];
export const NARRATION_MODES = ['simple', 'professional'];

// Returns the lowercased value if it's one of `allowed`, otherwise undefined.
export function normalizeChoice(value, allowed) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return allowed.includes(v) ? v : undefined;
}

const LENGTH_TEXT = {
  banter:
    'RESPONSE LENGTH — BANTER: Write zero narration. No action beats, no scene description, no inner monologue. ' +
    'Reply with exactly one sentence of dialogue, like a fast back-and-forth conversation. Never write more than one sentence.',
  short:
    'RESPONSE LENGTH — SHORT: Keep every reply under 250 words. Be economical: advance the scene, then stop.',
  medium:
    'RESPONSE LENGTH — MEDIUM: Aim for 300 to 450 words per reply. Balance dialogue, action, and description.',
  long:
    'RESPONSE LENGTH — LONG: Aim for 450 to 650 words per reply. Develop the scene fully, with room for ' +
    'description, interiority, and layered dialogue.',
  novel:
    'RESPONSE LENGTH — NOVEL: Write at least 700 words per reply, in the manner of a full novel chapter section. ' +
    'Take your time with pacing, setting, and character interiority. Do not wrap up or rush to an ending.',
};

const NARRATION_TEXT = {
  simple:
    'NARRATION STYLE — SIMPLE: Keep narration plain and grounded. No overly dramatic or purple prose. ' +
    'Show, don\'t tell: convey emotion through concrete actions, body language, and dialogue instead of naming feelings. ' +
    'Prefer short, clear, natural sentences.',
  professional:
    'NARRATION STYLE — PROFESSIONAL: Write at the level of an award-winning published novel. Use precise, ' +
    'evocative sensory detail, varied sentence rhythm, strong subtext, and distinct character voice. ' +
    'Every line should earn its place. Show through specific, fresh detail rather than stating emotions outright.',
};

const NO_AISM_TEXT =
  'NO AI CLICHES: Avoid stock AI-writing habits. Do not use: "ministrations", "orbs" for eyes, "shivers down the spine", ' +
  '"a mix of X and Y" emotion constructions, "couldn\'t help but", "barely above a whisper", "the air was thick with", ' +
  '"testament to", "tapestry", "a symphony of", "eyes sparkling with mischief", "breath hitched", "let out a breath ' +
  'they didn\'t know they were holding", "smirk" as a default expression, or "you\'re not just X, you\'re Y" ' +
  'constructions. Do not end replies with a summary, a moral, or a question to the user. Avoid repeating the same ' +
  'sentence structure or opener across replies, and avoid the "not X, but Y" rhythm. Prefer specific, concrete wording over generic filler.';

const MARKDOWN_TEXT =
  'FORMATTING: Use consistent markdown conventions in every reply:\n' +
  '- Spoken dialogue goes in double quotes: "Like this."\n' +
  '- Narration and actions go in italics: *She crossed the room.*\n' +
  '- Inner monologue goes in italic parentheses: *(I should leave.)*\n' +
  '- Text messages, chats and phone screens go in backticks: `omw, 5 min`\n' +
  '- Sounds and onomatopoeia go in bold inside the narration: **Thud.**\n' +
  '- Whispered or emphasized words may use italics inside the quotes; shouting may use **bold** caps.\n' +
  '- Written notes, signs, letters and documents go in a blockquote (> ).\n' +
  '- Thoughts, speech, and narration must never be mixed within a single formatting span.\n' +
  'Apply these consistently; never leave narration unformatted or dialogue unquoted.';

const LIVING_WORLD_TEXT =
  'LIVING WORLD: The setting is populated and continues without the main characters. NPCs have their own lives, ' +
  'goals, moods, and conversations. Crowded places have audible, overlapping chatter, people jostling and bumping ' +
  'into each other, and background events unfolding. Weather, time of day, and ambient activity change over time. ' +
  'NPCs may react to what the characters say and do, notice things, interrupt, or pursue their own business. ' +
  'Weave this in naturally without letting it derail or overwhelm the main scene.';

const REAL_TEXTING_TEXT =
  'REALISTIC TEXTING: Whenever a character sends a text, DM, or chat message, write it the way that specific ' +
  'person would actually type it. Match their personality, age, and background: slang, abbreviations, emoticons ' +
  'or emoji, lowercase, missing punctuation, typos, run-ons, double-texting, and short bursts of several messages. ' +
  'If the character is formal or precise, they use perfect grammar and punctuation instead. Never make every ' +
  'character text in the same voice, and don\'t over-polish casual texters.';

// Builds the combined directive text for a cfg, or undefined if nothing is on.
export function buildRoleplayDirectives(cfg = {}) {
  const parts = [];

  const length = normalizeChoice(cfg.responseLength, RESPONSE_LENGTHS);
  if (length) parts.push(LENGTH_TEXT[length]);

  const narration = normalizeChoice(cfg.narrationMode, NARRATION_MODES);
  // Banter has no narration at all, so a narration style would contradict it.
  if (narration && length !== 'banter') parts.push(NARRATION_TEXT[narration]);

  if (cfg.noAism) parts.push(NO_AISM_TEXT);
  if (cfg.forceMarkdown) parts.push(MARKDOWN_TEXT);
  if (cfg.livingWorld && length !== 'banter') parts.push(LIVING_WORLD_TEXT);
  if (cfg.realTexting) parts.push(REAL_TEXTING_TEXT);

  if (!parts.length) return undefined;
  return 'ROLEPLAY STYLE DIRECTIVES (follow these in every reply):\n\n' + parts.join('\n\n');
}

// Appends directive text to an existing Gemini systemInstruction (which may
// be undefined). Returns undefined if there is nothing to send at all.
export function mergeSystemInstruction(base, extraText) {
  if (!extraText) return base;
  if (!base) return { parts: [{ text: extraText }] };
  return { ...base, parts: [...(base.parts || []), { text: extraText }] };
}
