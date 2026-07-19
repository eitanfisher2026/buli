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
    'gemini-2.5-flash-lite':     { in: 0.10, out: 0.40 },
    'gemini-2.5-flash':          { in: 0.30, out: 2.50 },
    'gemini-2.5-pro':            { in: 1.25, out: 10.00 },
    'gemini-3.1-flash-lite':     { in: 0.25, out: 1.50 },
  },
  openai: {
    'gpt-4o-mini':  { in: 0.15, out: 0.60 },
    'gpt-4o':       { in: 2.50, out: 10.00 },
    'gpt-4.1':      { in: 2.00, out: 8.00 },
    'gpt-4.1-mini': { in: 0.40, out: 1.60 },
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
    if (status === 429 || msg.includes('rate limit') || msg.includes('quota exceeded') || msg.includes('too many requests') || msg.includes('rate_limit_exceeded')) {
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

exports.listAuthorizedUsers = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const snap = await db.ref('authorizedUsers').once('value');
    const val = snap.val() || {};
    const resolveExtra = async (email) => {
      const emailKey = (email || '').replace(/\./g, ',');
      const uidSnap = await db.ref(`usersByEmail/${emailKey}`).once('value');
      const uid = uidSnap.val();
      let noAi = false, nickname = null, pricingEnabled = false;
      if (uid) {
        const [noAiSnap, nickSnap, pricingSnap] = await Promise.all([
          db.ref(`users/${uid}/ai/noAi`).once('value'),
          db.ref(`users/${uid}/nickname`).once('value'),
          db.ref(`users/${uid}/pricingEnabled`).once('value'),
        ]);
        noAi = !!noAiSnap.val();
        nickname = nickSnap.val() || null;
        pricingEnabled = !!pricingSnap.val();
      }
      return { noAi, nickname, pricingEnabled };
    };
    const users = await Promise.all(Object.values(val).map(async (u) => {
      return Object.assign({}, u, await resolveExtra(u.email));
    }));
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    const ownerExtra = await resolveExtra(OWNER_EMAIL);
    return {
      owner: OWNER_EMAIL, ownerNoAi: ownerExtra.noAi, ownerNickname: ownerExtra.nickname,
      ownerPricingEnabled: ownerExtra.pricingEnabled, users,
    };
  }
);

exports.setUserNoAi = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, noAi } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const emailKey = rawEmail.trim().toLowerCase().replace(/\./g, ',');
    const uidSnap = await db.ref(`usersByEmail/${emailKey}`).once('value');
    const uid = uidSnap.val();
    if (!uid) throw new HttpsError('not-found', 'That person has not signed in yet');
    await db.ref(`users/${uid}/ai/noAi`).set(!!noAi);
    return { ok: true };
  }
);

exports.setUserNickname = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, nickname: rawNickname } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const emailKey = rawEmail.trim().toLowerCase().replace(/\./g, ',');
    const uidSnap = await db.ref(`usersByEmail/${emailKey}`).once('value');
    const uid = uidSnap.val();
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
      const emailKey = email.replace(/\./g, ',');
      const uidSnap = await db.ref(`usersByEmail/${emailKey}`).once('value');
      const uid = uidSnap.val();
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
    const emailKey = email.replace(/\./g, ',');
    const uidSnap = await db.ref(`usersByEmail/${emailKey}`).once('value');
    const uid = uidSnap.val();
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
};
const FTP_HOST = 'url.retail.publishedprices.co.il';
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
    const payload = { items, updatedAt: Date.now() };
    await db.ref(`vendorCatalog/${vendor}/${branchId}`).set(payload);
    await recordPricingUsage({ catalogWriteBytes: Buffer.byteLength(JSON.stringify(payload)), catalogRefreshCount: 1 });
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

async function getUserActiveBranches(uid) {
  const snap = await db.ref(`users/${uid}/activeBranch`).once('value');
  const val = snap.val() || {};
  return {
    ramiLevy: val.ramiLevy || DEFAULT_BRANCH.ramiLevy,
    osherAd: val.osherAd || DEFAULT_BRANCH.osherAd,
  };
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

  // A barcode may have matched via one vendor's name; fill in the other
  // vendor's price too if that same barcode exists there, even though its
  // (possibly differently-worded) name isn't what matched the query.
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
    score: entry.bestScore + (vendorNames.every(v => entry.prices[v] != null) ? 20 : 0),
    ramiLevy: entry.prices.ramiLevy ?? null,
    osherAd: entry.prices.osherAd ?? null,
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

exports.resolveItemBarcodes = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { items, force } = request.data || {};
    if (!Array.isArray(items) || items.length === 0) throw new HttpsError('invalid-argument', 'items array required');

    const activeBranch = await getUserActiveBranches(request.auth.uid);
    const [ramiLevy, osherAd] = await Promise.all([
      ensureFreshCatalog('ramiLevy', activeBranch.ramiLevy).catch(() => ({})),
      ensureFreshCatalog('osherAd', activeBranch.osherAd).catch(() => ({})),
    ]);
    const catalogsByVendor = { ramiLevy, osherAd };

    const results = {};
    for (const rawName of items) {
      const name = String(rawName || '').trim();
      if (!name) continue;
      // force=true (manual "search again") bypasses the cache read entirely —
      // otherwise a stale/wrong global match would just get re-applied.
      const cached = force ? null : (await db.ref(`itemBarcodes/${itemNameKey(name)}`).once('value')).val();
      if (cached) {
        results[name] = { cached: true, barcode: cached.barcode, matchedName: cached.name };
      } else {
        results[name] = { cached: false, candidates: fuzzyMatchCatalogs(name, catalogsByVendor) };
      }
    }
    return { results };
  }
);

exports.confirmItemBarcode = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { name, barcode, matchedName } = request.data || {};
    if (!name || !barcode) throw new HttpsError('invalid-argument', 'name and barcode required');
    await db.ref(`itemBarcodes/${itemNameKey(name)}`).set({
      barcode: String(barcode), name: String(matchedName || name).trim(), matchedAt: Date.now(),
    });
    return { ok: true };
  }
);

exports.getBasketPrices = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: 'europe-west1' },
  async (request) => {
    await requireAuthorized(request);
    const { barcodes, force } = request.data || {};
    if (!Array.isArray(barcodes) || barcodes.length === 0) throw new HttpsError('invalid-argument', 'barcodes array required');

    const activeBranch = await getUserActiveBranches(request.auth.uid);

    if (force) {
      // Explicit "רענן מחירים" action — a real re-fetch from the vendor is
      // exactly what was asked for, so the cost/latency here is expected.
      const [ramiLevy, osherAd] = await Promise.all([
        ingestVendorCatalog('ramiLevy', activeBranch.ramiLevy).catch(() => ({})),
        ingestVendorCatalog('osherAd', activeBranch.osherAd).catch(() => ({})),
      ]);
      const prices = {};
      for (const barcode of barcodes) {
        prices[barcode] = { ramiLevy: ramiLevy[barcode]?.price ?? null, osherAd: osherAd[barcode]?.price ?? null };
      }
      return { prices };
    }

    // Default path runs on every list open — must never download a whole
    // catalog (thousands of items, real RTDB bandwidth cost) or trigger a
    // synchronous vendor re-fetch (30-50s) just to read a handful of prices.
    // Point-reads cost the same regardless of how big the catalog is.
    const prices = {};
    await Promise.all(barcodes.map(async (barcode) => {
      const [ramiSnap, osherSnap] = await Promise.all([
        db.ref(`vendorCatalog/ramiLevy/${activeBranch.ramiLevy}/items/${barcode}/price`).once('value'),
        db.ref(`vendorCatalog/osherAd/${activeBranch.osherAd}/items/${barcode}/price`).once('value'),
      ]);
      prices[barcode] = { ramiLevy: ramiSnap.val() ?? null, osherAd: osherSnap.val() ?? null };
    }));
    await recordPricingUsage({ pointReadCount: barcodes.length * 2 });
    return { prices };
  }
);

exports.setUserPricingEnabled = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'europe-west1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, enabled } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const emailKey = rawEmail.trim().toLowerCase().replace(/\./g, ',');
    const uidSnap = await db.ref(`usersByEmail/${emailKey}`).once('value');
    const uid = uidSnap.val();
    if (!uid) throw new HttpsError('not-found', 'That person has not signed in yet');
    await db.ref(`users/${uid}/pricingEnabled`).set(!!enabled);
    return { ok: true };
  }
);
