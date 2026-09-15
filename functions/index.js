const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

admin.initializeApp();
const db = admin.database();

// ─── Access control ───────────────────────────────────────────────────────────
const OWNER_EMAIL = 'eitanfisher100@gmail.com';

function sanitizeEmailKey(email) {
  return email.trim().toLowerCase().replace(/\./g, ',');
}

// Looks up a user's uid from their email via the usersByEmail index — null
// if they've never signed in. Always normalizes (trim+lowercase) so this
// can't drift from sanitizeEmailKey's normalization the way separate
// hand-rolled copies of this lookup previously could.
async function resolveUidByEmail(email) {
  const snap = await db.ref(`usersByEmail/${sanitizeEmailKey(String(email || ''))}`).once('value');
  return snap.val() || null;
}

async function getRole(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (normalized === OWNER_EMAIL) return 'admin';
  const snap = await db.ref(`authorizedUsers/${sanitizeEmailKey(normalized)}`).once('value');
  const rec = snap.val();
  return rec ? rec.role : null;
}

async function requireAuthorized(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
  const role = await getRole(request.auth.token.email);
  if (!role) {
    throw new HttpsError('permission-denied',
      'החשבון שלך אינו מורשה להשתמש בבולי.\n\nמה לעשות: בקש מהמנהל להוסיף אותך תחת הגדרות → ניהול משתמשים.'
    );
  }
  return role;
}

function requireAdmin(role) {
  if (role !== 'admin') throw new HttpsError('permission-denied', 'נדרשת הרשאת מנהל.');
}

// ─── Cost tracking (per user, per month, per AI provider) ─────────────────────
async function recordCost(request, ai, inputTokens, outputTokens) {
  const costUsd = calcCostUsd(ai, inputTokens, outputTokens);
  if (costUsd > 0 && request.auth) {
    const uid = request.auth.uid;
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    await Promise.all([
      db.ref(`userCosts/${uid}/email`).set(request.auth.token.email || null),
      db.ref(`userCosts/${uid}/costs/${month}/${ai.type}`).set(admin.database.ServerValue.increment(costUsd)),
    ]).catch(() => {}); // never fail the user-facing request over a cost-logging hiccup
  }
  return costUsd;
}

// ─── AI pricing ($ per million tokens) ───────────────────────────────────────
const PRICING = {
  anthropic: {
    'claude-sonnet-4-6':          { in: 3, out: 15 },
    'claude-haiku-4-5-20251001':  { in: 1, out: 5 },
  },
  gemini: {
    'gemini-2.0-flash-lite':     { in: 0.075, out: 0.30 },
    'gemini-2.0-flash':          { in: 0.10, out: 0.40 },
    'gemini-2.5-flash-lite':     { in: 0.10, out: 0.40 },
    'gemini-2.5-flash':          { in: 0.30, out: 2.50 },
    'gemini-2.5-pro':            { in: 1.25, out: 10.00 },
    'gemini-3.1-flash-lite':     { in: 0.25, out: 1.50 },
    'gemini-3.5-flash':          { in: 1.50, out: 9.00 },
    'gemini-3.1-pro-preview':    { in: 2.00, out: 12.00 },
    'gemini-omni-flash-preview': { in: 1.50, out: 9.00 },
  },
  openai: {
    'gpt-4o-mini':   { in: 0.15, out: 0.60 },
    'gpt-4o':        { in: 2.50, out: 10.00 },
    'gpt-4.1':       { in: 2.00, out: 8.00 },
    'gpt-4.1-mini':  { in: 0.40, out: 1.60 },
    'gpt-5.4-nano':  { in: 0.20, out: 1.25 },
    'gpt-5.4-mini':  { in: 0.75, out: 4.50 },
    'gpt-5.4':       { in: 2.50, out: 15.00 },
    'gpt-5.4-pro':   { in: 30.00, out: 180.00 },
    'gpt-5.5':       { in: 5.00, out: 30.00 },
    'gpt-5.5-pro':   { in: 30.00, out: 180.00 },
    'gpt-5.6-luna':  { in: 1.00, out: 6.00 },
    'gpt-5.6-terra': { in: 2.50, out: 15.00 },
    'gpt-5.6-sol':   { in: 5.00, out: 30.00 },
    'gpt-5.3-codex': { in: 1.75, out: 14.00 },
    'chat-latest':   { in: 5.00, out: 30.00 },
  }
};

// ─── AI abstraction ───────────────────────────────────────────────────────────
function makeAI(data) {
  const { provider, geminiApiKey, geminiModel, openaiApiKey, openaiModel, anthropicApiKey, anthropicModel } = data || {};

  if (provider === 'gemini' && geminiApiKey) {
    // gemini-2.5-flash (no "-lite") stopped being issued to new API keys — auto-heal
    // anyone whose saved settings still point at a retired/restricted model.
    const DEPRECATED = {
      'gemini-2.0-flash': 'gemini-2.5-flash-lite',
      'gemini-2.0-flash-lite': 'gemini-2.5-flash-lite',
      'gemini-2.5-flash': 'gemini-2.5-flash-lite',
      'gemini-3-flash-preview': 'gemini-2.5-flash-lite',
    };
    const rawModel = geminiModel || 'gemini-2.5-flash-lite';
    const model = DEPRECATED[rawModel] || rawModel;
    return { type: 'gemini', client: new GoogleGenerativeAI(geminiApiKey), model };
  }
  if (provider === 'openai' && openaiApiKey) {
    const model = openaiModel || 'gpt-4o-mini';
    return { type: 'openai', client: new OpenAI({ apiKey: openaiApiKey }), model };
  }
  if (provider === 'anthropic' && anthropicApiKey) {
    const model = anthropicModel || 'claude-haiku-4-5-20251001';
    return { type: 'anthropic', client: new Anthropic({ apiKey: anthropicApiKey }), model };
  }
  throw new HttpsError('failed-precondition',
    'לא הוגדר ספק AI.\n\nמה לעשות: פתח הגדרות → הגדרות AI והזן מפתח API של Gemini, OpenAI או Anthropic.'
  );
}

// images (optional): [{ data: base64String, mimeType }] — used only by the
// recipe-from-photo feature. Every other caller omits it and gets the
// original plain-text behavior.
async function callAI(ai, prompt, maxTokens, images) {
  try {
    if (ai.type === 'gemini') {
      const gemModel = ai.client.getGenerativeModel({ model: ai.model });
      const parts = (images || []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
      parts.push({ text: prompt });
      const result = await gemModel.generateContent(parts);
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      return { text, usage: { input_tokens: meta?.promptTokenCount || 0, output_tokens: meta?.candidatesTokenCount || 0 } };
    }
    if (ai.type === 'openai') {
      const content = images && images.length
        ? [{ type: 'text', text: prompt }].concat(images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })))
        : prompt;
      const completion = await ai.client.chat.completions.create({
        model: ai.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }]
      });
      return {
        text: completion.choices[0].message.content,
        usage: { input_tokens: completion.usage?.prompt_tokens || 0, output_tokens: completion.usage?.completion_tokens || 0 }
      };
    }
    // Anthropic
    const content = images && images.length
      ? images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })).concat([{ type: 'text', text: prompt }])
      : prompt;
    const resp = await ai.client.messages.create({
      model: ai.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }]
    });
    return { text: resp.content[0].text, usage: resp.usage };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    const msg = (e.message || '').toLowerCase();
    const status = e.status || e.statusCode || 0;
    const name = ai.type === 'gemini' ? 'Gemini' : ai.type === 'openai' ? 'OpenAI' : 'Claude';
    if (status === 401 || msg.includes('api key') || msg.includes('api_key_invalid') || msg.includes('invalid x-api-key') || msg.includes('incorrect api key') || msg.includes('authentication_error') || msg.includes('invalid_api_key')) {
      throw new HttpsError('permission-denied',
        `מפתח ה-${name} שלך אינו תקין או פג תוקף.\n\nמה לעשות: פתח הגדרות → הגדרות AI, מחק את המפתח הנוכחי והדבק מפתח תקין.`
      );
    }
    if (msg.includes('insufficient_quota') || msg.includes('exceeded your current quota') || msg.includes('billing') || e.code === 'insufficient_quota') {
      throw new HttpsError('resource-exhausted',
        `לחשבון ה-${name} שלך אין מכסה זמינה — בדרך כלל זה אומר שלא הוגדר אמצעי תשלום, או שנגמר קרדיט ניסיון חינמי.\n\nמה לעשות: היכנס לעמוד החיוב בחשבון ה-${name} שלך והוסף אמצעי תשלום, ואז נסה שוב.`
      );
    }
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('rate_limit_exceeded')) {
      throw new HttpsError('resource-exhausted',
        `הגעת למגבלת הקצב של ${name} — נשלחו יותר מדי בקשות במהירות.\n\nמה לעשות: המתן 30–60 שניות ונסה שוב, או עבור לספק AI אחר בהגדרות.`
      );
    }
    if (status === 403 || msg.includes('permission denied') || msg.includes('access denied')) {
      throw new HttpsError('permission-denied',
        `למפתח ה-${name} שלך אין הרשאה למודל הזה (${ai.model}).\n\nמה לעשות: ודא שיש לחשבון גישה למודל, או בחר מודל אחר בהגדרות → הגדרות AI.`
      );
    }
    throw new HttpsError('internal', `שגיאת ${name}: ${e.message}`);
  }
}

function calcCostUsd(ai, inputTokens, outputTokens) {
  if (ai.type === 'gemini') {
    const p = PRICING.gemini[ai.model] || PRICING.gemini['gemini-2.5-flash-lite'];
    return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  }
  if (ai.type === 'openai') {
    const p = PRICING.openai[ai.model] || PRICING.openai['gpt-4o-mini'];
    return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  }
  const p = PRICING.anthropic[ai.model] || PRICING.anthropic['claude-haiku-4-5-20251001'];
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

function extractJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new HttpsError('internal', 'לא ניתן לפרסר את תשובת ה-AI');
  let parsed;
  try { parsed = JSON.parse(match[0]); }
  catch { throw new HttpsError('internal', 'לא ניתן לפרסר את תשובת ה-AI'); }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new HttpsError('internal', 'לא זוהו פריטים בטקסט');
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Item parsing — free-text/voice shopping input → structured, categorized items
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_AI_PROMPT = 'אתה מסייע לסיווג פריטי קנייה בעברית לקטגוריות.\n\nקטגוריות זמינות — חייב להשתמש באחד השמות המדויקים האלו:\n{categories}\n\nכללים:\n1. זהה כל פריט נפרד בטקסט (גם אם כתובים ברשימה, גם אם בטקסט חופשי)\n2. לכל פריט, בחר את הקטגוריה המתאימה ביותר מהרשימה\n3. שם הקטגוריה חייב להיות זהה לחלוטין לאחד השמות ברשימה — אל תשנה, אל תקצר, אל תתרגם\n4. "שונות" — רק אם אין שום קטגוריה מתאימה אחרת\n5. אם לא צוינה כמות — הכנס 1. אם לא צוינה יחידה — הכנס "יחידות"\n6. הערה (note) — רק אם קיימת בטקסט, אחרת ""\n7. שם הפריט (name) — העתק בדיוק כפי שהמשתמש כתב או אמר, באותה שפה. אסור בתכלית האיסור לתרגם לאנגלית או לכל שפה אחרת, גם אם שם המוצר או המותג מקורו לועזי — שמור על הכתיב (בעברית/אנגלית/אחר) כפי שהופיע בטקסט המקורי\n\nיחידות אפשריות: יחידות / ק"ג / גרם / ליטר / מ"ל / קופסה / חבילה / צרור\n\nפרמט JSON נדרש:\n[{"name":"שם הפריט","quantity":1,"unit":"יחידות","category":"שם קטגוריה מדויק","note":""}]\n\nטקסט: {text}\n\nהחזר מערך JSON בלבד, ללא הסברים:';

exports.parseItems = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { text, categories, prompt } = request.data || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      throw new HttpsError('invalid-argument', 'text required');
    }
    const cats = Array.isArray(categories) && categories.length > 0
      ? categories
      : [{ label: 'שונות' }];
    const catLabels = cats.map(c => c.label).join(' / ');

    let template = DEFAULT_AI_PROMPT;
    if (typeof prompt === 'string' && prompt.includes('{categories}') && prompt.includes('{text}')) {
      template = prompt;
    }
    const finalPrompt = template.replace('{categories}', catLabels).replace('{text}', text);

    const ai = makeAI(request.data);
    const { text: raw, usage } = await callAI(ai, finalPrompt, 2048);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);

    const items = extractJsonArray(raw);
    return { items };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Live model catalog — lets Settings show each provider's current model list
// (ours goes stale as providers ship new models) with a price hint per model.
// ─────────────────────────────────────────────────────────────────────────────
function cheapestModelId(models) {
  const priced = models.filter(m => m.price);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (a.price.in + a.price.out) <= (b.price.in + b.price.out) ? a : b).id;
}

exports.listProviderModels = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { provider, apiKey } = request.data || {};
    if (!apiKey || typeof apiKey !== 'string') throw new HttpsError('invalid-argument', 'apiKey required');

    async function fetchJson(url, headers) {
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        throw new HttpsError('unavailable', `לא ניתן היה להגיע לספק: ${e.message}`);
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new HttpsError('permission-denied', 'מפתח ה-API נדחה. בדוק אותו ונסה שוב.');
        }
        throw new HttpsError('failed-precondition', `לא ניתן היה לקבל רשימת מודלים (HTTP ${res.status}).`);
      }
      return res.json();
    }

    if (provider === 'openai') {
      const json = await fetchJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` });
      const EXCLUDE = /embedding|whisper|tts|dall-e|davinci|babbage|moderation|realtime|audio|transcribe|image|search|omni-moderation/i;
      const models = (json.data || [])
        .filter(m => /^(gpt-|o[1-9]|chatgpt|chat-)/i.test(m.id) && !EXCLUDE.test(m.id))
        .map(m => ({ id: m.id, price: PRICING.openai[m.id] || null }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, cheapestId: cheapestModelId(models) };
    }
    if (provider === 'anthropic') {
      const json = await fetchJson('https://api.anthropic.com/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
      const models = (json.data || [])
        .map(m => ({ id: m.id, label: m.display_name || null, price: PRICING.anthropic[m.id] || null }))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return { models, cheapestId: cheapestModelId(models) };
    }
    if (provider === 'gemini') {
      const json = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {});
      const models = (json.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && !/embedding|aqa|imagen|veo/i.test(m.name))
        .map(m => {
          const id = m.name.replace(/^models\//, '');
          return { id, label: m.displayName || null, price: PRICING.gemini[id] || null };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, cheapestId: cheapestModelId(models) };
    }
    throw new HttpsError('invalid-argument', 'Unknown provider');
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Access control — who's allowed to use the app, and the admin panel behind it
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyRole = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
    const role = await getRole(request.auth.token.email);
    // Mirror role onto userAccess/{uid} so database rules (which can't see this
    // function's email→role lookup) can gate shared family data by uid instead.
    await db.ref(`userAccess/${request.auth.uid}`).set({
      authorized: !!role,
      role: role || null,
      email: request.auth.token.email || null,
    }).catch(() => {});
    return { role };
  }
);

exports.getCosts = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    const { scope } = request.data || {};
    if (scope === 'all') {
      requireAdmin(role);
      const snap = await db.ref('userCosts').once('value');
      const val = snap.val() || {};
      const users = Object.entries(val).map(([uid, u]) => ({ uid, email: u.email || null, costs: u.costs || {} }));
      return { users };
    }
    const snap = await db.ref(`userCosts/${request.auth.uid}/costs`).once('value');
    return { costs: snap.val() || {} };
  }
);

// Unset (never chosen) fields resolve to each preference's default rather
// than a blanket false/off — menusEnabled and tasksEnabled default OFF,
// keyboardWarning (the beep when an item name is typed starting in the
// wrong keyboard language) defaults ON — matching what a brand-new user
// gets the first time these are ever read on the client.
async function resolveUserExtra(email) {
  const uid = await resolveUidByEmail(email);
  let nickname = null, menusEnabled = false, tasksEnabled = false, keyboardWarning = true, lastLogin = null;
  if (uid) {
    const [nickSnap, menusSnap, tasksSnap, keyboardWarningSnap, lastLoginSnap] = await Promise.all([
      db.ref(`users/${uid}/nickname`).once('value'),
      db.ref(`users/${uid}/menusEnabled`).once('value'),
      db.ref(`users/${uid}/tasksEnabled`).once('value'),
      db.ref(`users/${uid}/keyboardWarning`).once('value'),
      db.ref(`users/${uid}/lastLogin`).once('value'),
    ]);
    nickname = nickSnap.val() || null;
    menusEnabled = menusSnap.val() === true;
    tasksEnabled = tasksSnap.val() === true;
    keyboardWarning = keyboardWarningSnap.val() !== false;
    lastLogin = lastLoginSnap.val() || null;
  }
  return { nickname, menusEnabled, tasksEnabled, keyboardWarning, lastLogin };
}

exports.listAuthorizedUsers = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    const email = request.auth.token.email;
    // Regular users only get their own row — the roster/add/remove view is admin-only.
    if (role !== 'admin') {
      const extra = await resolveUserExtra(email);
      return { self: Object.assign({ email, role }, extra) };
    }
    const snap = await db.ref('authorizedUsers').once('value');
    const val = snap.val() || {};
    const users = await Promise.all(Object.values(val).map(async (u) => {
      return Object.assign({}, u, await resolveUserExtra(u.email));
    }));
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    const ownerExtra = await resolveUserExtra(OWNER_EMAIL);
    return {
      owner: OWNER_EMAIL, ownerNickname: ownerExtra.nickname,
      ownerMenusEnabled: ownerExtra.menusEnabled,
      ownerTasksEnabled: ownerExtra.tasksEnabled,
      ownerKeyboardWarning: ownerExtra.keyboardWarning,
      ownerLastLogin: ownerExtra.lastLogin, users,
    };
  }
);

exports.setUserNickname = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    const { email: rawEmail, nickname: rawNickname } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const isSelf = rawEmail.trim().toLowerCase() === (request.auth.token.email || '').toLowerCase();
    if (!isSelf) requireAdmin(role);
    const uid = await resolveUidByEmail(rawEmail);
    if (!uid) throw new HttpsError('not-found', 'That person has not signed in yet');
    const nickname = (typeof rawNickname === 'string' ? rawNickname.trim() : '').slice(0, 40);
    await db.ref(`users/${uid}/nickname`).set(nickname || null);
    return { ok: true };
  }
);

// Unlike listAuthorizedUsers (admin-only), this is callable by any authorized user —
// it's the "who can I share a list with" roster, not the access-management panel.
exports.listTeamMembers = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const snap = await db.ref('authorizedUsers').once('value');
    const val = snap.val() || {};
    const emails = [OWNER_EMAIL, ...Object.values(val).map(u => u.email)];
    const members = await Promise.all(emails.map(async (email) => {
      const uid = await resolveUidByEmail(email);
      let name = email;
      if (uid) {
        const [nameSnap, nickSnap] = await Promise.all([
          db.ref(`users/${uid}/name`).once('value'),
          db.ref(`users/${uid}/nickname`).once('value'),
        ]);
        if (nameSnap.exists() && nameSnap.val()) name = nameSnap.val();
        if (nickSnap.exists() && nickSnap.val()) name = nickSnap.val();
      }
      return { uid: uid || null, email, name };
    }));
    // Only people who have actually signed in at least once can be shared with (sharing needs a uid)
    return { members: members.filter(m => m.uid) };
  }
);

async function mirrorUserAccess(email, role) {
  // Best-effort: if this email has already signed in before, we know its uid via
  // usersByEmail and can flip its access immediately instead of waiting for next login.
  try {
    const uid = await resolveUidByEmail(email);
    if (!uid) return;
    await db.ref(`userAccess/${uid}`).set({ authorized: !!role, role: role || null, email });
  } catch {}
}

exports.addAuthorizedUser = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, role: newRole } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Invalid email address');
    if (email === OWNER_EMAIL) throw new HttpsError('invalid-argument', 'That email is already the owner');
    const finalRole = newRole === 'admin' ? 'admin' : 'user';
    const key = sanitizeEmailKey(email);
    const existingSnap = await db.ref(`authorizedUsers/${key}`).once('value');
    const existing = existingSnap.val();
    const record = {
      email, role: finalRole,
      addedAt: existing?.addedAt || new Date().toISOString(),
      addedBy: existing?.addedBy || request.auth.token.email,
    };
    if (existing && existing.role !== finalRole) {
      record.updatedAt = new Date().toISOString();
      record.updatedBy = request.auth.token.email;
    }
    await db.ref(`authorizedUsers/${key}`).set(record);
    await mirrorUserAccess(email, finalRole);
    return { ok: true };
  }
);

exports.removeAuthorizedUser = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const email = rawEmail.trim().toLowerCase();
    await db.ref(`authorizedUsers/${sanitizeEmailKey(email)}`).remove();
    await mirrorUserAccess(email, null);
    return { ok: true };
  }
);

// menusEnabled/tasksEnabled/keyboardWarning aren't security-rule-restricted
// like nickname (a user can already write their own directly) — this
// callable exists purely so an admin can set them for someone ELSE, same
// self-or-admin gate as setUserNickname.
exports.setUserPreferences = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    const { email: rawEmail, menusEnabled, tasksEnabled, keyboardWarning } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const isSelf = rawEmail.trim().toLowerCase() === (request.auth.token.email || '').toLowerCase();
    if (!isSelf) requireAdmin(role);
    const uid = await resolveUidByEmail(rawEmail);
    if (!uid) throw new HttpsError('not-found', 'That person has not signed in yet');
    const updates = {};
    if (typeof menusEnabled === 'boolean') updates.menusEnabled = menusEnabled;
    if (typeof tasksEnabled === 'boolean') updates.tasksEnabled = tasksEnabled;
    if (typeof keyboardWarning === 'boolean') updates.keyboardWarning = keyboardWarning;
    if (Object.keys(updates).length === 0) throw new HttpsError('invalid-argument', 'nothing to update');
    await db.ref(`users/${uid}`).update(updates);
    return { ok: true };
  }
);

// ─── Recipes (menus feature) ────────────────────────────────────────────────────
// No in-app search anymore — three different Hebrew recipe sites were each
// tried as an in-app "search this site" source, and each broke in its own
// undocumented way under real dish-name queries (JS-only results, 404s on
// any multi-word query, a static "recommended posts" widget masquerading as
// search results...). The one thing that worked reliably every time, across
// every site tried, was reading ONE specific page once a URL was in hand.
// So that's the whole feature now: the user finds a recipe however they
// normally would (Google, Instagram, a cookbook) and either pastes its link
// or attaches photo(s) of it; Buli reads that one source and extracts it.

// A self-identifying bot UA ("BuliBot/1.0") got intermittently 403'd by at
// least one site's WAF (mako) — this fetches one page a user explicitly
// chose, the same as their own browser would, so there's no reason to
// announce automation and invite that treatment.
const RECIPE_FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' };
const MAX_RECIPE_IMAGES = 5;
const MAX_IMAGE_BASE64_CHARS = 6_000_000; // ~4.5MB decoded — generous given the client resizes to ~1600px JPEG first

function extractJsonLdObjects(html) {
  const objects = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1]); } catch (e) { continue; }
    const items = Array.isArray(data) ? data : (Array.isArray(data['@graph']) ? data['@graph'] : [data]);
    items.forEach((it) => { if (it && typeof it === 'object') objects.push(it); });
  }
  return objects;
}

function findJsonLdType(objects, type) {
  return objects.find((o) => {
    const t = o['@type'];
    return t === type || (Array.isArray(t) && t.includes(type));
  }) || null;
}

function recipeImageUrl(image) {
  if (!image) return '';
  if (typeof image === 'string') return image;
  if (Array.isArray(image)) return recipeImageUrl(image[0]);
  if (image.url) return image.url;
  return '';
}

function parseServings(recipeYield) {
  if (!recipeYield) return null;
  const str = Array.isArray(recipeYield) ? String(recipeYield[0]) : String(recipeYield);
  const match = str.match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

// recipeInstructions is either an array (of strings, HowToStep objects, or
// HowToSection objects with nested itemListElement) or, on some sites, one
// long string with the steps run together as "1. ...2. ...３. ...". Both
// shapes get normalized into a flat array of step strings.
function normalizeInstructions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const steps = [];
    raw.forEach((step) => {
      if (typeof step === 'string') { steps.push(step.trim()); return; }
      if (!step || typeof step !== 'object') return;
      if (step['@type'] === 'HowToSection' && Array.isArray(step.itemListElement)) {
        step.itemListElement.forEach((s) => { if (s && (s.text || s.name)) steps.push(String(s.text || s.name).trim()); });
        return;
      }
      if (step.text || step.name) steps.push(String(step.text || step.name).trim());
    });
    return steps.filter(Boolean);
  }
  if (typeof raw === 'string') {
    const parts = raw.split(/(?=\d+[.)]\s)/).map((s) => s.trim()).filter(Boolean);
    return parts.length > 1 ? parts : [raw.trim()];
  }
  return [];
}

// ─── SSRF guard for extractRecipeFromUrl ────────────────────────────────────────
// The old fetchRecipe only ever fetched one of 2-3 hardcoded domains. This one
// fetches whatever URL the user pastes, so it needs its own defense against
// being pointed at internal infrastructure (localhost, cloud metadata
// endpoints, private IP ranges) — resolve the hostname first and check the
// actual resolved address, not just the hostname string, since a hostname can
// look external while resolving internally.
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] >= 224) return true; // multicast/reserved
    return false;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('::ffff:')) return isBlockedIp(lower.slice(7));
  return false;
}

async function assertPublicHttpUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch (e) { throw new HttpsError('invalid-argument', 'קישור לא תקין'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new HttpsError('invalid-argument', 'קישור לא תקין');
  if (parsed.hostname === 'localhost') throw new HttpsError('invalid-argument', 'קישור לא נתמך');
  let addresses;
  try { addresses = await dns.lookup(parsed.hostname, { all: true }); }
  catch (e) { throw new HttpsError('invalid-argument', 'לא ניתן לפענח את הכתובת'); }
  if (!addresses.length || addresses.some((a) => isBlockedIp(a.address))) {
    throw new HttpsError('invalid-argument', 'קישור לא נתמך');
  }
  return parsed;
}

// ─── AI extraction (shared by the URL and photo paths) ──────────────────────────
function recipeExtractionPrompt(sourceDescription) {
  return `להלן ${sourceDescription}. חלץ ממנו מתכון בישול, אם יש כזה.

החזר אך ורק JSON תקין (ללא markdown, ללא הסברים, ללא טקסט נוסף) בפורמט הבא:
{"title": "שם המנה", "servings": מספר או null, "ingredients": ["מרכיב 1", "מרכיב 2"], "steps": ["שלב 1", "שלב 2"]}

כללים:
- "title" — שם המנה, כפי שמופיע במקור.
- "servings" — מספר הסועדים/מנות שהמתכון מכין, רק אם צוין באופן מפורש. אם לא צוין, החזר null. אל תנחש.
- "ingredients" — כל שורת מרכיב בדיוק כפי שהיא כתובה במקור (כמות, יחידה ותיאור יחד, כמחרוזת אחת לכל מרכיב).
- "steps" — שלבי ההכנה, שלב אחד לכל איבר במערך.
- אם אין מתכון אמיתי (עם מרכיבים ואופן הכנה) במקור, החזר: {"error": "not_a_recipe"}`;
}

function parseRecipeAiResponse(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let data;
  try { data = JSON.parse(cleaned); }
  catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new HttpsError('not-found', 'לא זוהה מתכון בתוכן שסופק');
    try { data = JSON.parse(match[0]); } catch (e2) { throw new HttpsError('not-found', 'לא זוהה מתכון בתוכן שסופק'); }
  }
  if (data.error) throw new HttpsError('not-found', 'לא זוהה מתכון בתוכן שסופק — נסה קישור או תמונה אחרת');
  const ingredients = Array.isArray(data.ingredients) ? data.ingredients.map((s) => String(s).trim()).filter(Boolean) : [];
  if (!ingredients.length) throw new HttpsError('not-found', 'לא זוהה מתכון בתוכן שסופק — נסה קישור או תמונה אחרת');
  const steps = Array.isArray(data.steps) ? data.steps.map((s) => String(s).trim()).filter(Boolean) : [];
  const servings = (typeof data.servings === 'number' && data.servings > 0) ? Math.round(data.servings) : null;
  return { title: (data.title || '').trim(), servings, ingredients, steps };
}

exports.extractRecipeFromUrl = onCall(
  { timeoutSeconds: 30, memory: '256MiB', region: 'me-west1' },
  async (request) => {
    await requireAuthorized(request);
    const rawUrl = request.data && request.data.url;
    if (!rawUrl) throw new HttpsError('invalid-argument', 'חסר קישור למתכון');
    const parsed = await assertPublicHttpUrl(rawUrl);

    let res;
    try {
      res = await fetch(parsed.toString(), { headers: RECIPE_FETCH_HEADERS, redirect: 'follow' });
    } catch (err) {
      console.error(`extractRecipeFromUrl(${parsed.hostname}) network error:`, err && err.message);
      throw new HttpsError('unavailable', 'הדף לא נטען, נסה שוב');
    }
    if (!res.ok) {
      console.error(`extractRecipeFromUrl(${parsed.hostname}): HTTP ${res.status} ${res.statusText}`);
      throw new HttpsError('unavailable', 'הדף לא נטען, נסה שוב');
    }
    const html = await res.text();

    // Free path first: most recipe sites already publish structured data for
    // search engines — use it directly if present, no AI call needed.
    const objects = extractJsonLdObjects(html);
    const found = findJsonLdType(objects, 'Recipe');
    if (found && Array.isArray(found.recipeIngredient) && found.recipeIngredient.length) {
      return {
        title: (found.name || '').trim(),
        image: recipeImageUrl(found.image),
        servings: parseServings(found.recipeYield),
        ingredients: found.recipeIngredient.map((s) => String(s).trim()).filter(Boolean),
        steps: normalizeInstructions(found.recipeInstructions),
        url: parsed.toString(),
      };
    }

    // Fallback: no structured data on this page — ask AI to read its text.
    // This is what makes "any recipe site", not just a few curated ones,
    // actually work: no per-site scraper to write and maintain.
    const $ = cheerio.load(html);
    $('script, style, nav, footer, header, noscript, svg').remove();
    const pageText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);
    if (!pageText) throw new HttpsError('not-found', 'לא נמצא תוכן בקישור הזה');

    const ai = makeAI(request.data);
    const { text, usage } = await callAI(ai, recipeExtractionPrompt('תוכן דף אינטרנט:\n\n' + pageText), 1500);
    await recordCost(request, ai, usage.input_tokens, usage.output_tokens);
    const recipe = parseRecipeAiResponse(text);
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    return Object.assign({}, recipe, { image: ogImage, url: parsed.toString() });
  }
);

exports.extractRecipeFromImages = onCall(
  { timeoutSeconds: 45, memory: '256MiB', region: 'me-west1' },
  async (request) => {
    await requireAuthorized(request);
    const images = request.data && request.data.images;
    if (!Array.isArray(images) || !images.length) throw new HttpsError('invalid-argument', 'לא צורפו תמונות');
    if (images.length > MAX_RECIPE_IMAGES) throw new HttpsError('invalid-argument', `עד ${MAX_RECIPE_IMAGES} תמונות בכל פעם`);
    const cleanImages = images.map((img) => {
      const data = img && img.data;
      const mimeType = img && img.mimeType;
      if (!data || typeof data !== 'string' || data.length > MAX_IMAGE_BASE64_CHARS) throw new HttpsError('invalid-argument', 'תמונה לא תקינה או גדולה מדי');
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new HttpsError('invalid-argument', 'סוג תמונה לא נתמך');
      return { data, mimeType };
    });

    const ai = makeAI(request.data);
    const prompt = recipeExtractionPrompt(
      cleanImages.length > 1 ? `${cleanImages.length} תמונות של אותו מתכון (ייתכן שהן עמודים/חלקים שונים)` : 'תמונה של מתכון'
    );
    const { text, usage } = await callAI(ai, prompt, 1500, cleanImages);
    await recordCost(request, ai, usage.input_tokens, usage.output_tokens);
    const recipe = parseRecipeAiResponse(text);
    return Object.assign({}, recipe, { image: '', url: null });
  }
);
