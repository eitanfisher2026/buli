const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');

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

// Realtime Database usage for the pricing feature — global (not per-user,
// since the catalog is shared infrastructure everyone reads from, and it's
// Eitan who pays regardless of who triggered which read). This is *our own*
// approximation of bytes moved, not a query against Google's actual billing
// data (RTDB doesn't expose that programmatically) — good enough to show
// whether the feature is behaving, not a substitute for the real invoice.
async function recordPricingUsage(fields) {
  const month = new Date().toISOString().slice(0, 7);
  const updates = {};
  for (const [key, value] of Object.entries(fields)) {
    updates[`pricingUsage/${month}/${key}`] = admin.database.ServerValue.increment(value);
  }
  await db.ref().update(updates).catch(() => {});
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

async function callAI(ai, prompt, maxTokens) {
  try {
    if (ai.type === 'gemini') {
      const gemModel = ai.client.getGenerativeModel({ model: ai.model });
      const result = await gemModel.generateContent(prompt);
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      return { text, usage: { input_tokens: meta?.promptTokenCount || 0, output_tokens: meta?.candidatesTokenCount || 0 } };
    }
    if (ai.type === 'openai') {
      const completion = await ai.client.chat.completions.create({
        model: ai.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      return {
        text: completion.choices[0].message.content,
        usage: { input_tokens: completion.usage?.prompt_tokens || 0, output_tokens: completion.usage?.completion_tokens || 0 }
      };
    }
    // Anthropic
    const resp = await ai.client.messages.create({
      model: ai.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
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

// Approximate RTDB bandwidth cost for the pricing feature specifically —
// global (see recordPricingUsage), admin-only since it's Eitan's Firebase
// bill this is estimating, not something tied to an individual user.
// Rates are the published Realtime Database Blaze prices as of this
// writing; treat the resulting $ figure as a rough order-of-magnitude
// estimate, not the actual invoice line (real billing also depends on
// region, free-tier thresholds, and everything else in the project).
const RTDB_DOWNLOAD_USD_PER_GB = 1;
const RTDB_STORAGE_USD_PER_GB_MONTH = 5;
exports.getPricingUsage = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const snap = await db.ref('pricingUsage').once('value');
    const val = snap.val() || {};
    const months = Object.entries(val).map(([month, m]) => {
      const readBytes = (m.catalogReadBytes || 0);
      const writeBytes = (m.catalogWriteBytes || 0);
      // Writes are actually billed as stored data, not download bandwidth —
      // approximating them at the download rate is deliberately the more
      // conservative (higher) estimate rather than the more precise one.
      const estimatedUsd = (readBytes / 1e9) * RTDB_DOWNLOAD_USD_PER_GB
        + (writeBytes / 1e9) * RTDB_STORAGE_USD_PER_GB_MONTH;
      return {
        month,
        catalogReadBytes: readBytes,
        catalogWriteBytes: writeBytes,
        catalogRefreshCount: m.catalogRefreshCount || 0,
        catalogReadCount: m.catalogReadCount || 0,
        pointReadCount: m.pointReadCount || 0,
        estimatedUsd,
      };
    }).sort((a, b) => b.month.localeCompare(a.month));
    return { months };
  }
);

// Reads only the small vendorCatalogIndex mirror (updatedAt/sizeBytes/
// itemCount per branch) plus the small vendorBranches name lists — never the
// multi-MB item blobs themselves — so admins can see and prune every branch
// ever ingested without that visibility itself costing real data transfer.
exports.listVendorCatalogs = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const [indexSnap, ...branchSnaps] = await Promise.all([
      db.ref('vendorCatalogIndex').once('value'),
      ...VENDOR_IDS.map((v) => db.ref(`vendorBranches/${v}`).once('value')),
    ]);
    const index = indexSnap.val() || {};
    const branchNames = {};
    VENDOR_IDS.forEach((v, i) => { branchNames[v] = branchSnaps[i].val() || {}; });

    const entries = [];
    for (const vendor of Object.keys(index)) {
      for (const [branchId, meta] of Object.entries(index[vendor] || {})) {
        const info = (branchNames[vendor] || {})[branchId] || {};
        entries.push({
          vendor, branchId,
          name: info.name || null,
          address: info.address || null,
          updatedAt: meta.updatedAt || null,
          sizeBytes: meta.sizeBytes || 0,
          itemCount: meta.itemCount || 0,
        });
      }
    }
    entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return { entries };
  }
);

// Deletes one branch's catalog (real data + its index mirror) — an explicit
// admin prune action, not tied to any automatic staleness/cleanup policy.
exports.deleteVendorCatalog = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { vendor, branchId } = request.data || {};
    if (!VENDORS[vendor] || !branchId) throw new HttpsError('invalid-argument', 'vendor and branchId required');
    await db.ref().update({
      [`vendorCatalog/${vendor}/${branchId}`]: null,
      [`vendorCatalogIndex/${vendor}/${branchId}`]: null,
    });
    return { ok: true };
  }
);

exports.listAuthorizedUsers = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const snap = await db.ref('authorizedUsers').once('value');
    const val = snap.val() || {};
    const resolveExtra = async (email) => {
      const uid = await resolveUidByEmail(email);
      let nickname = null, pricingEnabled = false, lastLogin = null;
      if (uid) {
        const [nickSnap, pricingSnap, lastLoginSnap] = await Promise.all([
          db.ref(`users/${uid}/nickname`).once('value'),
          db.ref(`users/${uid}/pricingEnabled`).once('value'),
          db.ref(`users/${uid}/lastLogin`).once('value'),
        ]);
        nickname = nickSnap.val() || null;
        pricingEnabled = !!pricingSnap.val();
        lastLogin = lastLoginSnap.val() || null;
      }
      return { nickname, pricingEnabled, lastLogin };
    };
    const users = await Promise.all(Object.values(val).map(async (u) => {
      return Object.assign({}, u, await resolveExtra(u.email));
    }));
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    const ownerExtra = await resolveExtra(OWNER_EMAIL);
    return {
      owner: OWNER_EMAIL, ownerNickname: ownerExtra.nickname,
      ownerPricingEnabled: ownerExtra.pricingEnabled, ownerLastLogin: ownerExtra.lastLogin, users,
    };
  }
);

exports.setUserNickname = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, nickname: rawNickname } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
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

// ─────────────────────────────────────────────────────────────────────────────
// Price comparison (Rami Levy / Osher Ad) — no AI anywhere in this feature.
// Vendor price data comes from Israel's price-transparency regulatory feed,
// served over explicit FTPS by a shared "Cerberus" server. See the plan doc
// for how the file naming/encoding/schema quirks here were verified against
// the live servers before this was written.
// ─────────────────────────────────────────────────────────────────────────────
const VENDORS = {
  ramiLevy: { ftpUser: 'RamiLevi' },
  osherAd: { ftpUser: 'osherad' },
  keshet: { ftpUser: 'Keshet' }, // קשת טעמים — same Cerberus platform, verified 2026-07-19
  yohananof: { ftpUser: 'yohananof' }, // יוחננוף — same Cerberus platform, verified 2026-07-19
};
const FTP_HOST = 'url.retail.publishedprices.co.il';
// Only vendors a brand-new user should start with pre-seeded (matches the
// two branches this app originally shipped with). A vendor added later
// (like Keshet) is opt-in only — everyone must explicitly add it via the
// vendor-profile picker, never silently becomes "active" for existing users.
const DEFAULT_BRANCH = { ramiLevy: '055', osherAd: '011' }; // Ramat HaHayal / Bnei Brak
const CATALOG_STALENESS_MS = 18 * 60 * 60 * 1000; // 18h — matches the feed's own refresh cadence

function asArray(x) {
  return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
}

function decodeXmlBuffer(buf) {
  const text = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
    ? buf.toString('utf16le')
    : buf.toString('utf8');
  return text.replace(/^﻿/, '');
}

function normalizeItemName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function itemNameKey(name) {
  return require('crypto').createHash('sha1').update(normalizeItemName(name)).digest('hex');
}

async function ftpConnect(vendor) {
  const ftp = require('basic-ftp');
  const client = new ftp.Client(30000);
  await client.access({
    host: FTP_HOST,
    user: VENDORS[vendor].ftpUser,
    password: '',
    secure: true,
    secureOptions: { rejectUnauthorized: false },
  });
  return client;
}

async function ftpDownloadBuffer(client, fileName) {
  const { Writable } = require('stream');
  const chunks = [];
  const sink = new Writable({ write(chunk, enc, cb) { chunks.push(chunk); cb(); } });
  await client.downloadTo(sink, fileName);
  return Buffer.concat(chunks);
}

async function ftpDownloadXmlObject(client, fileEntry) {
  let buf = await ftpDownloadBuffer(client, fileEntry.name);
  if (fileEntry.name.endsWith('.gz')) buf = require('zlib').gunzipSync(buf);
  const { XMLParser } = require('fast-xml-parser');
  const parser = new XMLParser({ ignoreAttributes: false });
  return parser.parse(decodeXmlBuffer(buf));
}

// Refreshes vendorBranches/{vendor} from the chain's own Stores file. Branches
// change rarely, so — unlike prices — this only runs when the cache is empty.
async function ingestVendorBranches(vendor) {
  const client = await ftpConnect(vendor);
  try {
    const list = await client.list();
    const storeFiles = list.filter(f => /^stores/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name));
    if (storeFiles.length === 0) return null;
    const obj = await ftpDownloadXmlObject(client, storeFiles[0]);
    const root = obj.Root || {};
    const branches = {};
    for (const subChain of asArray(root.SubChains?.SubChain)) {
      for (const s of asArray(subChain.Stores?.Store)) {
        const id = String(s.StoreID ?? '').padStart(3, '0');
        if (!id || id === '000') continue;
        branches[id] = {
          name: String(s.StoreName ?? '').trim() || `Store ${id}`,
          address: String(s.Address ?? '').replace(/&#x0?[dDaA];/g, '').replace(/[\r\n]+/g, '').trim(),
          city: String(s.City ?? '').trim(),
        };
      }
    }
    if (Object.keys(branches).length === 0) return null;
    await db.ref(`vendorBranches/${vendor}`).set(branches);
    return branches;
  } finally {
    client.close();
  }
}

// Refreshes vendorCatalog/{vendor}/{branchId} from that branch's latest full
// price snapshot. Writes the whole catalog in one .set() — cheap in RTDB
// regardless of item count (bills by bytes, not by write count).
async function ingestVendorCatalog(vendor, branchId) {
  const client = await ftpConnect(vendor);
  try {
    const list = await client.list();
    const branchFiles = list.filter(f => f.name.includes(`-${branchId}-`));
    let candidates = branchFiles.filter(f => /pricefull/i.test(f.name));
    if (candidates.length === 0) candidates = branchFiles.filter(f => /price/i.test(f.name));
    candidates.sort((a, b) => b.name.localeCompare(a.name));
    const pick = candidates[0];
    if (!pick) throw new HttpsError('not-found', `No price file found for ${vendor} branch ${branchId}`);

    const obj = await ftpDownloadXmlObject(client, pick);
    const root = obj.Root || {};
    const items = {};
    for (const item of asArray(root.Items?.Item)) {
      const barcode = String(item.ItemCode ?? '').trim();
      const price = parseFloat(item.ItemPrice);
      if (!barcode || !Number.isFinite(price)) continue;
      items[barcode] = {
        name: String(item.ItemName ?? '').trim(),
        price,
        unit: String(item.UnitOfMeasure ?? item.UnitQty ?? '').trim(),
      };
    }
    const sizeBytes = Buffer.byteLength(JSON.stringify(items));
    const updatedAt = Date.now();
    const payload = { items, updatedAt, sizeBytes };
    // A tiny sibling index (metadata only, never the item blobs) so the
    // admin "loaded branches" panel can list every branch ever ingested
    // without paying to read any of the real (multi-MB) catalog data.
    await db.ref().update({
      [`vendorCatalog/${vendor}/${branchId}`]: payload,
      [`vendorCatalogIndex/${vendor}/${branchId}`]: { updatedAt, sizeBytes, itemCount: Object.keys(items).length },
    });
    await recordPricingUsage({ catalogWriteBytes: sizeBytes, catalogRefreshCount: 1 });
    return items;
  } finally {
    client.close();
  }
}

async function ensureFreshCatalog(vendor, branchId, force) {
  if (!force) {
    const metaSnap = await db.ref(`vendorCatalog/${vendor}/${branchId}/updatedAt`).once('value');
    const updatedAt = metaSnap.val();
    if (updatedAt && Date.now() - updatedAt < CATALOG_STALENESS_MS) {
      const itemsSnap = await db.ref(`vendorCatalog/${vendor}/${branchId}/items`).once('value');
      const items = itemsSnap.val() || {};
      await recordPricingUsage({ catalogReadBytes: Buffer.byteLength(JSON.stringify(items)), catalogReadCount: 1 });
      return items;
    }
  }
  return ingestVendorCatalog(vendor, branchId);
}

// Plain substring/token-overlap matching — no AI. Grocery names are literal
// enough that this, combined with a human picking from the shortlist, is
// both sufficient and free.
// Scores each vendor's catalog independently and takes a fixed slice from
// each side before merging — otherwise a query that scores well against one
// vendor's (much bigger) catalog can crowd the other vendor out of the
// candidate list entirely, even when a perfectly good match exists there too.
// Scores a normalized catalog name against a normalized query. Returns null
// when there's no match at all.
const VENDOR_IDS = Object.keys(VENDORS);
const DEFAULT_MAX_ACTIVE_VENDORS = 3;

async function getMaxActiveVendors() {
  const snap = await db.ref('pricingConfig/maxActiveVendors').once('value');
  const v = snap.val();
  return (Number.isFinite(v) && v > 0) ? v : DEFAULT_MAX_ACTIVE_VENDORS;
}

// A "profile" is one vendor chain + one specific branch the user tracks —
// distinct from a vendor chain itself, since the same chain can appear as
// two profiles at once (comparing two branches of Rami Levy, say). Only up
// to the admin-set cap are ever actually queried here, regardless of how
// many the client has marked active, so the cost/latency ceiling always
// holds no matter what the client sends.
async function getUserActiveProfiles(uid) {
  const [profilesSnap, cap] = await Promise.all([
    db.ref(`users/${uid}/vendorProfiles`).once('value'),
    getMaxActiveVendors(),
  ]);
  const all = profilesSnap.val() || {};
  let entries = Object.entries(all)
    .filter(([, p]) => p && p.active && VENDOR_IDS.includes(p.vendor) && p.branchId);
  if (entries.length === 0) {
    // Nobody has picked profiles yet — fall back to the original seeded
    // defaults only (not every integrated vendor), so existing users keep
    // working without a migration step, and a newly-added vendor never
    // silently becomes "active" for people who haven't chosen it.
    return Object.keys(DEFAULT_BRANCH).map(v => ({ id: `default-${v}`, vendor: v, branchId: DEFAULT_BRANCH[v] })).slice(0, cap);
  }
  entries.sort((a, b) => (a[1].addedAt || 0) - (b[1].addedAt || 0));
  return entries.slice(0, cap).map(([id, p]) => ({ id, vendor: p.vendor, branchId: String(p.branchId) }));
}

function scoreCatalogName(name, q, qTokens) {
  const nameTokens = name.split(' ').filter(Boolean);
  const overlap = qTokens.filter(t => nameTokens.includes(t)).length;
  if (name === q) return 100;
  // Matching ALL query words is a different tier from matching SOME of
  // them — a multi-word query like "בשר קצוץ" (chopped meat) must not
  // score the same for a candidate that only matches "קצוץ" (chopped —
  // a generic preparation-style modifier shared by meat, onion, nuts,
  // anything) as for one that's actually about meat. Missing the other
  // word entirely means it's very likely a different product, not a
  // looser match of the same one.
  if (overlap > 0 && overlap === qTokens.length) {
    let score = 70;
    // Hebrew grocery names put the primary category noun first
    // ("חלב 3% תנובה" — milk, then brand/qualifiers); compound or flavored
    // products put the category word later ("שוקולד חלב" — milk
    // *chocolate*, "מקציף חלב" — milk *frother*). Boosting matches at the
    // start of the name is what actually separates "milk" from "things
    // that mention milk" when the query itself is a single word.
    if (nameTokens.slice(0, qTokens.length).join(' ') === q) score += 20;
    else if (nameTokens[0] === qTokens[0]) score += 10;
    return score;
  }
  if (overlap > 0) return 15 + Math.round((overlap / qTokens.length) * 15);
  // Whole-word overlap must outrank raw substring containment — Hebrew
  // roots embed into unrelated words (e.g. "חלב" milk is a literal
  // substring of "חלבי" dairy/adjective and "חלבון" protein) — so this
  // stays the weakest tier, checked only once nothing else matched.
  if (name.includes(q) || q.includes(name)) return 15;
  return null;
}

// Searches both vendor catalogs at once and merges by barcode — a barcode
// is a manufacturer-assigned code (GTIN/EAN), not a vendor-specific one, so
// there's no reason to search one catalog, then the other, then try to
// reconcile afterward. Every candidate already carries whichever vendors'
// prices exist for that exact product, so picking one is the final answer —
// no follow-up price fetch is needed.
function fuzzyMatchCatalogs(query, catalogsByVendor) {
  const q = normalizeItemName(query);
  const qTokens = q.split(' ').filter(Boolean);
  const vendorNames = Object.keys(catalogsByVendor);
  const byBarcode = {};

  for (const vendor of vendorNames) {
    for (const [barcode, item] of Object.entries(catalogsByVendor[vendor] || {})) {
      const name = normalizeItemName(item.name);
      if (!name) continue;
      const score = scoreCatalogName(name, q, qTokens);
      if (score === null) continue;
      if (!byBarcode[barcode]) {
        byBarcode[barcode] = { barcode, name: item.name, unit: item.unit, bestScore: -1, prices: {} };
      }
      const entry = byBarcode[barcode];
      entry.prices[vendor] = item.price;
      if (score > entry.bestScore) {
        entry.bestScore = score;
        entry.name = item.name;
        entry.unit = item.unit;
      }
    }
  }

  // A barcode may have matched via one vendor's name; fill in any other
  // searched vendor's price too if that same barcode exists there, even
  // though its (possibly differently-worded) name isn't what matched the
  // query. A vendor key stays entirely absent (not just null) when this
  // barcode genuinely doesn't exist in that vendor's catalog — that
  // distinction lets the caller tell "searched and not sold here" apart
  // from "vendor wasn't part of this search" (see resolveItemBarcodes).
  for (const entry of Object.values(byBarcode)) {
    for (const vendor of vendorNames) {
      if (entry.prices[vendor] === undefined) {
        const other = (catalogsByVendor[vendor] || {})[entry.barcode];
        if (other) entry.prices[vendor] = other.price;
      }
    }
  }

  const list = Object.values(byBarcode).map(entry => ({
    barcode: entry.barcode,
    name: entry.name,
    unit: entry.unit,
    score: entry.bestScore + (vendorNames.length > 1 && vendorNames.every(v => entry.prices[v] != null) ? 20 : 0),
    prices: entry.prices,
  }));
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, 10);
}

exports.getVendorBranches = onCall(
  { timeoutSeconds: 180, memory: '512MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { vendor } = request.data || {};
    if (!VENDORS[vendor]) throw new HttpsError('invalid-argument', 'valid vendor required');
    const snap = await db.ref(`vendorBranches/${vendor}`).once('value');
    let branches = snap.val();
    if (!branches || Object.keys(branches).length === 0) {
      branches = await ingestVendorBranches(vendor);
    }
    return { branches: branches || {} };
  }
);

// Logs a request for a chain that isn't wired up yet — "supported" is never
// cached as a flag anywhere; it's always just "does VENDORS contain this
// vendor right now", so a chain we can't do today is never permanently
// blocked from being added in a future version. This just gives the admin
// visibility into what people are asking for.
exports.requestVendor = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const name = String((request.data || {}).name || '').trim();
    if (!name) throw new HttpsError('invalid-argument', 'name required');
    await db.ref(`vendorRequests/${itemNameKey(name)}`).set({
      name, requestedBy: request.auth.token.email, requestedAt: Date.now(),
    });
    return { ok: true };
  }
);

exports.listVendorRequests = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const snap = await db.ref('vendorRequests').once('value');
    const val = snap.val() || {};
    const requests = Object.entries(val).map(([id, r]) => ({ id, ...r }));
    requests.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
    return { requests };
  }
);

// Admin dismisses a request once handled (chain added, or decided against) —
// this only clears the log entry, it never writes any "unsupported" marker.
exports.dismissVendorRequest = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { id } = request.data || {};
    if (!id) throw new HttpsError('invalid-argument', 'id required');
    await db.ref(`vendorRequests/${id}`).remove();
    return { ok: true };
  }
);

// Returns, per item name: whichever vendors are already resolved (from the
// global itemBarcodes cache) plus fuzzy-match candidates for whichever
// vendors are still missing. A "vendor" here is never hardcoded to exactly
// two — everything iterates VENDOR_IDS, so adding a third chain is just
// another VENDORS/DEFAULT_BRANCH entry, no logic changes. An optional
// `vendors` filter scopes the search to specific vendor(s) only — used for
// the "also match this one separately" follow-up when a shared barcode
// doesn't exist (e.g. butcher-counter items priced by weight, which each
// chain codes internally rather than under a real shared GTIN).
exports.getPricingSettings = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    return { maxActiveVendors: await getMaxActiveVendors() };
  }
);

exports.setMaxActiveVendors = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const n = parseInt((request.data || {}).value, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10) throw new HttpsError('invalid-argument', 'value must be between 1 and 10');
    await db.ref('pricingConfig/maxActiveVendors').set(n);
    return { ok: true };
  }
);

exports.resolveItemBarcodes = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { items, force, vendors } = request.data || {};
    if (!Array.isArray(items) || items.length === 0) throw new HttpsError('invalid-argument', 'items array required');

    // Name→barcode matching is chain-wide, not branch-specific (a GTIN
    // doesn't change by branch) — so when two active profiles share a
    // chain, one representative branch per chain is enough to search.
    const activeProfiles = await getUserActiveProfiles(request.auth.uid);
    const repProfileByVendor = {};
    activeProfiles.forEach(p => { if (!repProfileByVendor[p.vendor]) repProfileByVendor[p.vendor] = p; });
    const vendorIds = Object.keys(repProfileByVendor).filter(v => !Array.isArray(vendors) || vendors.includes(v));
    if (vendorIds.length === 0) throw new HttpsError('invalid-argument', 'no active vendors');

    const catalogsByVendor = {};
    await Promise.all(vendorIds.map(async (vendor) => {
      const p = repProfileByVendor[vendor];
      catalogsByVendor[vendor] = await ensureFreshCatalog(vendor, p.branchId).catch(() => ({}));
    }));

    const results = {};
    for (const rawName of items) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      // force=true (manual "search again") bypasses the cache read entirely —
      // otherwise a stale/wrong global match would just get re-applied.
      const cachedSnap = force ? null : (await db.ref(`itemBarcodes/${itemNameKey(name)}`).once('value')).val();
      const barcodes = {};
      if (cachedSnap) vendorIds.forEach(v => { if (cachedSnap[v]) barcodes[v] = cachedSnap[v]; });
      const missingVendors = vendorIds.filter(v => !barcodes[v]);

      if (missingVendors.length === 0) {
        results[name] = { barcodes, missingVendors: [] };
        continue;
      }
      const missingCatalogs = {};
      missingVendors.forEach(v => { missingCatalogs[v] = catalogsByVendor[v]; });
      results[name] = { barcodes, missingVendors, candidates: fuzzyMatchCatalogs(name, missingCatalogs) };
    }
    return { results };
  }
);

// Writes into the global name→barcode cache for whichever vendors the
// caller confirmed (defaults to all vendors, for the common case of a
// shared-barcode candidate picked from a merged search).
exports.confirmItemBarcode = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { name, barcode, matchedName, vendors } = request.data || {};
    if (!name || !barcode) throw new HttpsError('invalid-argument', 'name and barcode required');
    const vendorList = (Array.isArray(vendors) ? vendors : VENDOR_IDS).filter(v => VENDOR_IDS.includes(v));
    if (vendorList.length === 0) throw new HttpsError('invalid-argument', 'no valid vendors');
    const entry = { barcode: String(barcode), name: String(matchedName || name).trim(), matchedAt: Date.now() };
    const updates = {};
    for (const vendor of vendorList) updates[`itemBarcodes/${itemNameKey(name)}/${vendor}`] = entry;
    await db.ref().update(updates);
    return { ok: true };
  }
);

// Input is keyed by vendor CHAIN (barcodes are chain-wide — see item.barcodes
// on the client). Output is keyed by PROFILE id, since price is specific to
// one branch — two active profiles on the same chain can have different
// prices for the same barcode. `profiles` echoes back the server-resolved,
// cap-enforced active list so the client's rendering always matches exactly
// what was actually priced, even if the client has more marked active than
// the current admin cap allows.
exports.getBasketPrices = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { barcodesByVendor, force } = request.data || {};
    if (!barcodesByVendor || typeof barcodesByVendor !== 'object') throw new HttpsError('invalid-argument', 'barcodesByVendor required');

    const activeProfiles = await getUserActiveProfiles(request.auth.uid);
    const relevantProfiles = activeProfiles.filter(p => Array.isArray(barcodesByVendor[p.vendor]) && barcodesByVendor[p.vendor].length > 0);
    const prices = {};
    if (relevantProfiles.length === 0) return { prices, profiles: activeProfiles };

    if (force) {
      // Explicit "רענן מחירים" action — a real re-fetch from the vendor is
      // exactly what was asked for, so the cost/latency here is expected.
      // Dedupe by (vendor,branchId) so two profiles sharing one branch
      // don't trigger the 30-50s re-ingest twice.
      const catalogByBranch = {};
      await Promise.all(relevantProfiles.map(async (p) => {
        const key = `${p.vendor}:${p.branchId}`;
        if (!catalogByBranch[key]) catalogByBranch[key] = ingestVendorCatalog(p.vendor, p.branchId).catch(() => ({}));
        const items = await catalogByBranch[key];
        prices[p.id] = {};
        barcodesByVendor[p.vendor].forEach(barcode => { prices[p.id][barcode] = items[barcode]?.price ?? null; });
      }));
      return { prices, profiles: activeProfiles };
    }

    // Default path runs on every list open — must never download a whole
    // catalog (thousands of items, real RTDB bandwidth cost) or trigger a
    // synchronous vendor re-fetch (30-50s) just to read a handful of prices.
    // Point-reads cost the same regardless of how big the catalog is.
    let readCount = 0;
    await Promise.all(relevantProfiles.map(async (p) => {
      prices[p.id] = {};
      await Promise.all(barcodesByVendor[p.vendor].map(async (barcode) => {
        const snap = await db.ref(`vendorCatalog/${p.vendor}/${p.branchId}/items/${barcode}/price`).once('value');
        prices[p.id][barcode] = snap.val() ?? null;
        readCount++;
      }));
    }));
    await recordPricingUsage({ pointReadCount: readCount });
    return { prices, profiles: activeProfiles };
  }
);

exports.setUserPricingEnabled = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, enabled } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const uid = await resolveUidByEmail(rawEmail);
    if (!uid) throw new HttpsError('not-found', 'That person has not signed in yet');
    await db.ref(`users/${uid}/pricingEnabled`).set(!!enabled);
    return { ok: true };
  }
);
