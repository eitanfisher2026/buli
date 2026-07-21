    const { useState, useEffect, useRef } = React;

    const VERSION = "v5.61";

    // ── CONFIG ────────────────────────────────────────────────────────────────────
    const FIREBASE_CONFIG = {
      apiKey: "AIzaSyCln4umpIgfDCxfkI6XHBo8Vtri5aAGo_E",
      authDomain: "buli-8fdf9.firebaseapp.com",
      databaseURL: "https://buli-8fdf9-default-rtdb.europe-west1.firebasedatabase.app",
      projectId: "buli-8fdf9",
      storageBucket: "buli-8fdf9.firebasestorage.app",
      messagingSenderId: "714195385676",
      appId: "1:714195385676:web:169e9205375a8d7737e3e9"
    };
    const DEFAULT_CATEGORIES = [
      { id: "vegetables", label: "ירקות ופירות", emoji: "🥦", order: 0 },
      { id: "pantry",     label: "קפה ושימורים", emoji: "☕", order: 1 },
      { id: "cleaning",   label: "חומרי ניקוי",  emoji: "🧴", order: 2 },
      { id: "dairy",      label: "מוצרי חלב",    emoji: "🥛", order: 3 },
      { id: "eggs",       label: "ביצים",         emoji: "🥚", order: 4 },
      { id: "paper",      label: "מוצרי נייר",   emoji: "🧻", order: 5 },
      { id: "other",      label: "שונות",         emoji: "🛍️", order: 6 }
    ];
    const UNITS = ["יחידות","ק״ג","גרם","ליטר","מ״ל","קופסה","חבילה","צרור"];

    const AI_PROVIDERS = {
      anthropic: { name: "Claude", label: "Anthropic", defaultModel: "claude-haiku-4-5-20251001", keyHint: "sk-ant-...", free: false },
      openai:    { name: "ChatGPT", label: "OpenAI",   defaultModel: "gpt-4o-mini",               keyHint: "sk-...",     free: false },
      gemini:    { name: "Gemini",  label: "Google",   defaultModel: "gemini-2.5-flash-lite",      keyHint: "AIza...",    free: true  }
    };
    // Shown before the user presses "refresh list" to pull the real, current
    // catalog from the provider — kept short since it goes stale over time.
    const FALLBACK_MODELS = {
      anthropic: [
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — מהיר וזול" },
        { id: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6 — חזק יותר" },
      ],
      openai: [
        { id: "gpt-4o-mini",  label: "GPT-4o Mini — מהיר וזול" },
        { id: "gpt-5.4-nano", label: "GPT-5.4 Nano — הכי זול" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
      ],
      gemini: [
        { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite — הכי זול" },
        { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash" },
        { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite — חדש וזול" },
      ],
    };
    function getAIModel(p) {
      return AI_PROVIDERS[p].defaultModel;
    }

    // ── FIREBASE ──────────────────────────────────────────────────────────────────
    firebase.initializeApp(FIREBASE_CONFIG);
    const auth = firebase.auth();
    const db   = firebase.database();
    const fns  = firebase.app().functions("europe-west1"); // must match functions region in functions/index.js

    // ── CATEGORIES HOOK ───────────────────────────────────────────────────────────
    function useCategories(userId) {
      const [categories, setCategories] = useState([]);
      useEffect(() => {
        if (!userId) return;
        const ref = db.ref("globalCategories");
        ref.on("value", snap => {
          if (snap.exists()) {
            const arr = [];
            snap.forEach(c => { arr.push({ id: c.key, ...c.val() }); });
            setCategories(arr.sort((a, b) => (a.order ?? 99) - (b.order ?? 99)));
          } else {
            setCategories([]);
          }
        });
        return () => ref.off();
      }, [userId]);
      return categories;
    }

    // ── AI PARSING ────────────────────────────────────────────────────────────────
    // AI keys never touch the client's network requests — parseItems (Cloud Function)
    // does the actual provider call server-side, using the caller's own stored key.
    var DEFAULT_AI_PROMPT = 'אתה מסייע לסיווג פריטי קנייה בעברית לקטגוריות.\n\nקטגוריות זמינות — חייב להשתמש באחד השמות המדויקים האלו:\n{categories}\n\nכללים:\n1. זהה כל פריט נפרד בטקסט (גם אם כתובים ברשימה, גם אם בטקסט חופשי)\n2. לכל פריט, בחר את הקטגוריה המתאימה ביותר מהרשימה\n3. שם הקטגוריה חייב להיות זהה לחלוטין לאחד השמות ברשימה — אל תשנה, אל תקצר, אל תתרגם\n4. "שונות" — רק אם אין שום קטגוריה מתאימה אחרת\n5. אם לא צוינה כמות — הכנס 1. אם לא צוינה יחידה — הכנס "יחידות"\n6. הערה (note) — רק אם קיימת בטקסט, אחרת ""\n7. שם הפריט (name) — העתק בדיוק כפי שהמשתמש כתב או אמר, באותה שפה. אסור בתכלית האיסור לתרגם לאנגלית או לכל שפה אחרת, גם אם שם המוצר או המותג מקורו לועזי — שמור על הכתיב (בעברית/אנגלית/אחר) כפי שהופיע בטקסט המקורי\n\nיחידות אפשריות: יחידות / ק"ג / גרם / ליטר / מ"ל / קופסה / חבילה / צרור\n\nפרמט JSON נדרש:\n[{"name":"שם הפריט","quantity":1,"unit":"יחידות","category":"שם קטגוריה מדויק","note":""}]\n\nטקסט: {text}\n\nהחזר מערך JSON בלבד, ללא הסברים:';

    function parseWithAI(text, categories, aiSettings) {
      var cats = categories.length > 0 ? categories : DEFAULT_CATEGORIES;
      var payload = Object.assign({
        text: text,
        categories: cats.map(function(c) { return { label: c.label }; })
      }, aiSettings || {});
      return fns.httpsCallable("parseItems")(payload).then(function(res) {
        return res.data.items;
      }, function(err) {
        throw new Error(err.message || "שגיאה בחיבור ל-AI");
      });
    }

    // ── VOICE ────────────────────────────────────────────────────────────────────
    // Copied from FouFou utils.js startSpeechToText — continuous:false prevents the
    // Chrome bug where stop() re-fires all prior results with resultIndex=0 (duplication).
    // onResult(text, isFinal) — same API as FouFou.
    function startSpeech({ onResult, onEnd, onError, maxMs, continuous }) {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { onError && onError("הדפדפן לא תומך בזיהוי קול — נסה Chrome"); return function(){}; }

      var r = new SR();
      r.lang = "he-IL";
      r.continuous = continuous ? true : false;
      r.interimResults = true;
      r.maxAlternatives = 1;

      var finalText = "";
      var timer = setTimeout(function() { try { r.stop(); } catch(e) {} }, maxMs || 30000);

      r.onresult = function(e) {
        var newFinal = "", interim = "";
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) newFinal += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        if (newFinal) { finalText += newFinal; onResult && onResult(newFinal, true); }
        else if (interim) { onResult && onResult(interim, false); }
      };

      r.onend = function() { clearTimeout(timer); onEnd && onEnd(finalText); };

      r.onerror = function(e) {
        clearTimeout(timer);
        if (e.error === "not-allowed") onError && onError("אנא אשר גישה למיקרופון");
        else if (e.error !== "aborted" && e.error !== "no-speech") onError && onError("שגיאה: " + e.error);
      };

      try { r.start(); } catch(e) {}
      return function() { clearTimeout(timer); try { r.stop(); } catch(e) {} };
    }

    // ── HELPERS ───────────────────────────────────────────────────────────────────
    const encodeEmail = e => e.replace(/\./g, ",");

    function nextFriday(ts) {
      var d = new Date(ts || Date.now());
      var daysUntil = (5 - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + daysUntil);
      return d.toISOString().split("T")[0];
    }

    function formatDinnerDate(dateStr) {
      if (!dateStr) return "";
      var p = dateStr.split("-");
      return p[2] + "/" + p[1] + "/" + p[0];
    }

    function formatRefreshTime(ts) {
      if (!ts) return "";
      var d = new Date(ts);
      var pad = function(n) { return String(n).padStart(2, "0"); };
      return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    // Three visually distinct states for a price badge: strictly cheaper
    // (green — the actual winner), available-but-not-cheapest (legible
    // neutral gray — includes ties, since equal prices have no winner),
    // and not sold there at all (dimmed gray — genuinely different from
    // "sold but pricier", which "not showing the winner in green" alone
    // doesn't communicate).
    // Vendor list drives every price-comparison UI element (badges, branch
    // pickers, totals) — adding a third chain later is just another entry
    // here plus the matching VENDORS/DEFAULT_BRANCH entry server-side, no
    // further UI rewiring.
    const VENDOR_LIST = [
      { id: "ramiLevy", label: "רמי לוי" },
      { id: "osherAd", label: "אושר עד" },
      { id: "keshet", label: "קשת טעמים" },
      { id: "yohananof", label: "יוחננוף" },
    ];
    const VENDOR_IDS = VENDOR_LIST.map(function(v) { return v.id; });
    // Module-level (not component state) so it survives ListScreen mounting
    // and unmounting as the user navigates in and out of a list — see the
    // comment where it's read in ListScreen for why that matters.
    // { [listId]: { priceMap, activeProfiles } }
    var priceCacheByList = {};
    // Same idea for HomeScreen's own list-of-lists — it also unmounts every
    // time you go into a list or another screen, so without this, every
    // "back to menu" tap re-triggers the full lists+tasks load (and its
    // spinner) even a second after you were just looking at it.
    var homeDataCache = null; // { lists, tasks }
    var homeDataPromise = null; // in-flight prewarm — shared so App() starting
    // it early and HomeScreen's own mount don't each fire a duplicate fetch.

    // listsByUser/{uid} is a point-read index kept up to date by every
    // create/share/delete path in HomeScreen — avoids scanning the app-wide
    // `lists` table (every user's every list) just to filter to "mine"
    // client-side. Existing users haven't had that index backfilled yet, so
    // each user does exactly one full scan (same cost as before this change,
    // no visibility regression) the first time, backfills their own index,
    // and marks themselves migrated so every load after that uses the cheap
    // indexed path instead.
    function loadMyListsFor(uid) {
      return Promise.all([
        db.ref("listsMigrated/" + uid).once("value"),
        db.ref("listsByUser/" + uid).once("value"),
      ]).then(function(results) {
        var migrated = results[0].val();
        var idxSnap = results[1];
        if (migrated) {
          var ids = Object.keys(idxSnap.val() || {});
          if (ids.length === 0) return [];
          return Promise.all(ids.map(function(id) { return db.ref("lists/" + id).once("value"); })).then(function(snaps) {
            var arr = [];
            snaps.forEach(function(s, i) {
              if (!s.exists()) return;
              var l = Object.assign({ id: ids[i] }, s.val());
              if (l.type !== "tasks") arr.push(l);
            });
            return arr;
          });
        }
        return db.ref("lists").once("value").then(function(snap) {
          var arr = []; var backfill = {};
          snap.forEach(function(c) {
            var l = Object.assign({ id: c.key }, c.val());
            var mine = l.ownerId === uid || (l.sharedWith && l.sharedWith[uid]);
            if (mine) backfill["listsByUser/" + uid + "/" + c.key] = true;
            if (mine && l.type !== "tasks") arr.push(l);
          });
          backfill["listsMigrated/" + uid] = true;
          db.ref().update(backfill).catch(function() {});
          return arr;
        });
      }).then(function(arr) {
        arr.sort(function(a, b) { return b.createdAt - a.createdAt; });
        return arr;
      });
    }
    function loadTasksFor(tasksListId) {
      return db.ref("items/" + tasksListId).once("value").then(function(snap) {
        var arr = [];
        snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
        arr.sort(function(a, b) {
          var ad = a.dueDate || "", bd = b.dueDate || "";
          if (!ad && !bd) return (a.createdAt || 0) - (b.createdAt || 0);
          if (!ad) return 1; if (!bd) return -1;
          return ad > bd ? 1 : ad < bd ? -1 : 0;
        });
        return arr;
      });
    }
    // RTDB's once('value') has no built-in timeout — if the connection dies
    // silently (much more common on mobile: screen lock, backgrounding,
    // switching wifi/cellular) the read never resolves *and* never rejects,
    // so it hangs forever with nothing for a .catch to catch. This races it
    // against a timeout so a stuck load surfaces as a retryable error instead.
    function withTimeout(promise, ms, message) {
      return new Promise(function(resolve, reject) {
        var settled = false;
        var timer = setTimeout(function() {
          if (settled) return;
          settled = true;
          reject(new Error(message));
        }, ms);
        promise.then(function(v) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }, function(e) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        });
      });
    }
    // Kicks off the lists+tasks load as early as possible — App() calls this
    // the moment it knows the uid, in parallel with the getMyRole round-trip,
    // instead of waiting for role to resolve before HomeScreen even mounts
    // and starts fetching. HomeScreen's own mount awaits this same call, so
    // whichever side triggers it first, the other just reuses the in-flight
    // promise rather than firing a second copy of the same reads.
    function prewarmHomeData(uid) {
      if (homeDataCache) return Promise.resolve(homeDataCache);
      if (homeDataPromise) return homeDataPromise;
      homeDataPromise = Promise.all([
        loadMyListsFor(uid),
        loadTasksFor("tasks_" + uid),
      ]).then(function(results) {
        homeDataCache = { lists: results[0], tasks: results[1] };
        homeDataPromise = null;
        return homeDataCache;
      }, function(err) {
        homeDataPromise = null;
        throw err;
      });
      return homeDataPromise;
    }
    // Autocomplete suggestions only — real, common Israeli chains, most of
    // which aren't actually wired up yet. Typing/picking one of these that
    // isn't in VENDOR_LIST above just surfaces the "ask the admin" request
    // flow; it's never a claim that the chain works.
    const VENDOR_NAME_SUGGESTIONS = VENDOR_LIST.map(function(v) { return v.label; }).concat([
      "שופרסל", "יינות ביתן", "ויקטורי", "טיב טעם", "מגה",
      "סופר פארם", "גוד פארם", "חצי חינם", "זול ובגדול", "מחסני השוק", "סופר יודה",
    ]);

    // A vendor's own barcode for an item, preferring the new per-vendor map
    // over the legacy single shared `barcode` field (pre-existing items that
    // haven't been re-matched since chains got independent barcodes).
    function itemVendorBarcode(item, vendorId) {
      return (item.barcodes && item.barcodes[vendorId]) || item.barcode || null;
    }
    // relevantVendorIds should be the distinct vendor chains among the
    // user's currently ACTIVE profiles — a vendor that's configured but
    // switched off (or never added) is irrelevant to "does this item still
    // need matching", so it must never count as "missing" just because the
    // app happens to support that chain in general.
    function itemMissingVendors(item, relevantVendorIds) {
      return (relevantVendorIds || VENDOR_IDS).filter(function(v) { return !itemVendorBarcode(item, v); });
    }
    function itemHasAnyBarcode(item) {
      return !!(item.barcode || (item.barcodes && Object.keys(item.barcodes).length > 0));
    }

    // "mine" wins (green) only if it's strictly cheaper than every other
    // known price — a tie has no winner. "others" is the list of the other
    // vendors' values (nulls allowed, filtered out) so this scales to any
    // number of vendors, not just a pairwise comparison.
    function cheapestBadgeClass(mine, others) {
      if (mine == null) return "bg-gray-50 text-gray-400";
      var known = others.filter(function(o) { return o != null; });
      if (known.length === 0 || known.every(function(o) { return mine < o; })) return "bg-green-100 text-green-700";
      return "bg-gray-100 text-gray-700";
    }
    function cheapestTextClass(mine, others) {
      if (mine == null) return "text-gray-400";
      var known = others.filter(function(o) { return o != null; });
      if (known.length === 0 || known.every(function(o) { return mine < o; })) return "text-green-600";
      return "text-gray-700";
    }

    // Plain vendor label ("רמי לוי"), disambiguated with the branch number
    // only when the user has more than one active profile on the same
    // chain — the common case (one branch per chain) stays uncluttered.
    function profileLabel(profile, allProfiles) {
      var meta = VENDOR_LIST.find(function(v) { return v.id === profile.vendor; });
      var label = meta ? meta.label : profile.vendor;
      var sameChainCount = allProfiles.filter(function(p) { return p.vendor === profile.vendor; }).length;
      if (sameChainCount > 1) label += " (סניף " + parseInt(profile.branchId, 10) + ")";
      return label;
    }
    // Resolves an item's price at every active profile it has a (chain-wide)
    // barcode for. Skips profiles whose price hasn't been fetched yet rather
    // than showing a misleading "not sold here" before the real answer
    // arrives.
    function itemProfilePrices(item, activeProfiles, priceMap) {
      var out = [];
      activeProfiles.forEach(function(p) {
        var bc = itemVendorBarcode(item, p.vendor);
        if (!bc) return;
        var vendorPrices = priceMap[p.id];
        if (!vendorPrices || !(bc in vendorPrices)) return;
        out.push({ profile: p, price: vendorPrices[bc] });
      });
      return out;
    }

    const USER_COLORS = ["#ef4444","#f97316","#22c55e","#14b8a6","#8b5cf6","#ec4899","#6366f1","#f59e0b"];
    function getUserColor(uid) {
      if (!uid) return "#94a3b8";
      var stored = localStorage.getItem("buli_user_color_" + uid);
      if (stored) return stored;
      var sum = 0;
      for (var i = 0; i < uid.length; i++) sum += uid.charCodeAt(i);
      return USER_COLORS[sum % USER_COLORS.length];
    }

    function Toast({ msg, onClose }) {
      useEffect(() => { const t = setTimeout(onClose, 3000); return () => clearTimeout(t); }, []);
      return (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-800 text-white text-sm px-5 py-2.5 rounded-full shadow-lg z-50 whitespace-nowrap">
          {msg}
        </div>
      );
    }
    function Spinner({ large }) {
      return large
        ? <div className="spinner w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full" />
        : <div className="spinner w-5 h-5 border-2 border-white border-t-transparent rounded-full inline-block" />;
    }
    // Animated cart — inline SVG (not a downloaded GIF/WebP) so the loading
    // screen itself costs zero extra network requests, matching this whole
    // cold-start effort. Solid gradient-filled cart (matches the app icon —
    // see public/icon.svg, same shape/gradient) drives left-to-right across
    // its track and loops; keyframes live in styles.css.
    function CartLoader() {
      return (
        <div className="cart-loader-track">
          <div className="cart-loader-rig-wrap">
            {/* Artwork is drawn facing right (basket/wheels right, trailing
                lines left); mirrored here so it faces left to match the
                right-to-left travel direction below. */}
            <svg className="cart-loader-rig" width="150" height="90" viewBox="0 0 150 90" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="cartLoaderGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" />
                  <stop offset="100%" stopColor="#2563eb" />
                </linearGradient>
              </defs>
              <ellipse cx="99" cy="89" rx="22" ry="3" fill="#93c5fd" opacity="0.4" />
              <line x1="2" y1="28" x2="34" y2="28" stroke="url(#cartLoaderGrad)" strokeWidth="5" strokeLinecap="round" opacity="0.35" />
              <line x1="8" y1="39" x2="46" y2="39" stroke="url(#cartLoaderGrad)" strokeWidth="5" strokeLinecap="round" opacity="0.55" />
              <line x1="2" y1="50" x2="42" y2="50" stroke="url(#cartLoaderGrad)" strokeWidth="5" strokeLinecap="round" opacity="0.75" />
              <line x1="12" y1="61" x2="44" y2="61" stroke="url(#cartLoaderGrad)" strokeWidth="5" strokeLinecap="round" opacity="0.9" />
              <path d="M56 16 H70 L79 32" stroke="url(#cartLoaderGrad)" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <path d="M79 32 H122 Q127 32 125 39 L114 72 Q112 77 107 77 H90 Q85 77 83 72 L72 39 Q70 32 79 32 Z" fill="url(#cartLoaderGrad)" />
              <line x1="91" y1="42" x2="89" y2="68" stroke="white" strokeWidth="2.2" opacity="0.85" />
              <line x1="102" y1="42" x2="101" y2="68" stroke="white" strokeWidth="2.2" opacity="0.85" />
              <line x1="82" y1="52" x2="115" y2="52" stroke="white" strokeWidth="2.2" opacity="0.85" />
              <line x1="85" y1="64" x2="112" y2="64" stroke="white" strokeWidth="2.2" opacity="0.85" />
              <circle cx="91" cy="84" r="8" fill="url(#cartLoaderGrad)" />
              <circle cx="91" cy="84" r="3" fill="white" />
              <circle cx="108" cy="84" r="8" fill="url(#cartLoaderGrad)" />
              <circle cx="108" cy="84" r="3" fill="white" />
            </svg>
          </div>
        </div>
      );
    }
    // Shared cold-start loading screen — one consistent look for every stage
    // (auth init, role check) instead of two blank near-identical screens,
    // with a real label reflecting what's actually happening at that moment.
    function LoadingScreen({ label }) {
      return (
        <div className="bg-gray-50 flex flex-col items-center justify-center gap-3" style={{height:"100dvh"}}>
          <CartLoader />
          {label && <p className="text-sm text-gray-400">{label}</p>}
        </div>
      );
    }
    function Modal({ onClose, children }) {
      const [dragY, setDragY] = React.useState(0);
      const startYRef = React.useRef(null);
      const handleRef = React.useRef(null);

      const onPointerDown = (e) => {
        startYRef.current = e.clientY;
        if (handleRef.current) handleRef.current.setPointerCapture(e.pointerId);
      };
      const onPointerMove = (e) => {
        if (startYRef.current === null) return;
        setDragY(Math.max(0, e.clientY - startYRef.current));
      };
      const onPointerUp = () => {
        if (dragY > 80) { onClose(); }
        else { setDragY(0); }
        startYRef.current = null;
      };

      return (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-end" onClick={onClose}>
          <div className="relative bg-white w-full max-w-md mx-auto rounded-t-3xl flex flex-col"
            style={{ transform: "translateY(" + dragY + "px)", transition: dragY === 0 ? "transform 0.2s ease" : "none", maxHeight: "88dvh" }}
            onClick={e => e.stopPropagation()}>
            <div className="relative flex-shrink-0 px-6 pt-6">
              <div ref={handleRef}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                className="w-10 h-1.5 bg-gray-200 rounded-full mx-auto mb-4 cursor-grab active:cursor-grabbing touch-none" />
              <button onClick={onClose} className="absolute top-4 left-4 text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
            </div>
            <div className="overflow-y-auto px-6 pb-8">
              {children}
            </div>
          </div>
        </div>
      );
    }
    function ConfirmDialog({ message, confirmLabel, onConfirm, onClose }) {
      return (
        <Modal onClose={onClose}>
          <p className="text-center text-gray-800 font-medium text-base mb-6">{message}</p>
          <div className="grid grid-cols-2 gap-3">
            <button onClick={onClose} className="py-3 rounded-2xl border border-gray-200 text-gray-600 font-medium">ביטול</button>
            <button onClick={function() { onClose(); onConfirm(); }} className="py-3 rounded-2xl bg-red-500 text-white font-semibold">{confirmLabel || "מחק"}</button>
          </div>
        </Modal>
      );
    }
    function Header({ onBack, title, right }) {
      return (
        <div className="bg-blue-600 text-white px-4 pt-10 pb-4">
          <div className="flex items-center gap-3" dir="ltr">
            {onBack && (
              <button onClick={onBack} className="flex items-center gap-1 text-white font-semibold text-sm bg-white/20 px-3 py-1.5 rounded-full flex-shrink-0">
                <span className="text-lg leading-none">‹</span><span>חזרה</span>
              </button>
            )}
            <h1 className="flex-1 text-lg font-bold truncate text-right">{title}</h1>
            {right}
          </div>
        </div>
      );
    }

    // ── CHECKBOX ──────────────────────────────────────────────────────────────────
    function Checkbox({ checked, onChange }) {
      return (
        <button onClick={onChange}
          className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center transition ${checked ? "bg-blue-600 border-blue-600" : "border-gray-400 bg-white"}`}>
          {checked && (
            <svg className="w-3 h-3 text-white" viewBox="0 0 12 10" fill="none">
              <path d="M1 5l3.5 3.5L11 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </button>
      );
    }

    // ── APP ───────────────────────────────────────────────────────────────────────
    function App() {
      const [user,        setUser]        = useState(null);
      const [loading,     setLoading]     = useState(true);
      const [role,        setRole]        = useState(null);
      const [roleLoading, setRoleLoading] = useState(true);
      const [simulateRegular, setSimulateRegular] = useState(function() {
        return sessionStorage.getItem("buli_simulate_regular") === "true";
      });
      const toggleSimulate = function(next) {
        setSimulateRegular(next);
        if (next) sessionStorage.setItem("buli_simulate_regular", "true");
        else sessionStorage.removeItem("buli_simulate_regular");
      };
      const [screen,   setScreen]   = useState("home");
      const [listId,   setListId]   = useState(null);
      const [listType, setListType] = useState("shopping");
      const [listName, setListName] = useState("");
      const [toast,       setToast]       = useState("");
      const [stickyToast, setStickyToast] = useState([]);
      const histDepthRef = useRef(2);
      const navHistoryRef = useRef([{ screen: "home" }]);

      useEffect(() => {
        // FouFou pattern: keep min 2 cushion entries so Android back never exhausts the stack.
        // App nav history is tracked in navHistoryRef (separate from browser history).
        window.history.replaceState({ d: 0 }, '', window.location.pathname);
        window.history.pushState({ d: 1 }, '', window.location.pathname);
        window.history.pushState({ d: 2 }, '', window.location.pathname);
        var onPop = function() {
          histDepthRef.current = Math.max(0, histDepthRef.current - 1);
          var hist = navHistoryRef.current;
          if (hist.length > 1) {
            hist.pop();
            var prev = hist[hist.length - 1];
            setScreen(prev.screen || "home");
            setListId(prev.listId || null);
            setListType(prev.listType || "shopping");
            setListName(prev.listName || "");
          }
          while (histDepthRef.current < 2) {
            histDepthRef.current++;
            window.history.pushState({ d: histDepthRef.current }, '', '/');
          }
        };
        window.addEventListener('popstate', onPop);
        return function() { window.removeEventListener('popstate', onPop); };
      }, []);

      useEffect(() => {
        var openMajor = new URLSearchParams(window.location.search).get('open') === 'major';
        auth.onAuthStateChanged(u => {
          setUser(u);
          setLoading(false);
          if (u) {
            setRoleLoading(true);
            // Fire this the moment we know the uid, in parallel with the role
            // check below, instead of waiting for role to resolve before
            // HomeScreen even mounts and starts fetching — shaves a full
            // round-trip off the cold-start chain. Harmless no-op if the
            // account turns out to be unauthorized (rules just deny the read).
            prewarmHomeData(u.uid).catch(function() {});
            fns.httpsCallable("getMyRole")().then(function(res) {
              setRole(res.data.role || null);
              setRoleLoading(false);
              if (res.data.role) {
                // Only write the shared, authorization-gated index once we're confirmed authorized —
                // otherwise this write races userAccess's server-side mirror and gets denied by rules.
                db.ref("usersByEmail/" + encodeEmail(u.email)).set(u.uid);
              }
            }, function() {
              setRole(null);
              setRoleLoading(false);
            });
            db.ref("users/" + u.uid).update({ name: u.displayName, email: u.email, photo: u.photoURL, lastLogin: Date.now() });
            db.ref("users/" + u.uid + "/color").once("value").then(function(snap) {
              if (snap.exists()) localStorage.setItem("buli_user_color_" + u.uid, snap.val());
            });
            if (openMajor) {
              var major = null;
              try { major = JSON.parse(localStorage.getItem("buli_major_list")); } catch(e) {}
              if (major && major.id) {
                window.history.replaceState({ d: 0 }, '', window.location.pathname);
                navHistoryRef.current.push({ screen: "add", listId: major.id, listType: "shopping", listName: major.name || "" });
                histDepthRef.current++; window.history.pushState({ d: histDepthRef.current }, '', '/');
                setListId(major.id); setListType("shopping"); setListName(major.name || ""); setScreen("add");
              }
            } else {
              var autoOpen = localStorage.getItem("buli_auto_open_major") === "true";
              var alreadyDone = sessionStorage.getItem("buli_auto_redirected") === "1";
              if (autoOpen && !alreadyDone) {
                var majorAuto = null;
                try { majorAuto = JSON.parse(localStorage.getItem("buli_major_list")); } catch(e) {}
                if (majorAuto && majorAuto.id) {
                  sessionStorage.setItem("buli_auto_redirected", "1");
                  navHistoryRef.current.push({ screen: "add", listId: majorAuto.id, listType: "shopping", listName: majorAuto.name || "" });
                  histDepthRef.current++; window.history.pushState({ d: histDepthRef.current }, '', '/');
                  setListId(majorAuto.id); setListType("shopping"); setListName(majorAuto.name || ""); setScreen("add");
                }
              }
            }
          }
        });
      }, []);

      if (loading)     return <LoadingScreen label="מתחבר..." />;
      if (!user)       return <LoginScreen />;
      if (roleLoading) return <LoadingScreen label="בודק הרשאות..." />;
      if (!role)       return <NotAuthorizedScreen user={user} />;

      const pushNav = (state) => { navHistoryRef.current.push(state); histDepthRef.current++; window.history.pushState({ d: histDepthRef.current }, '', '/'); };
      const go = s => { pushNav({ screen: s }); setScreen(s); };
      const goList = (id, name) => { pushNav({ screen: "list", listId: id, listName: name || "" }); setListId(id); setListName(name || ""); setScreen("list"); };
      const goAdd  = (id, type, name) => { pushNav({ screen: "add", listId: id, listType: type || "shopping", listName: name || "" }); setListId(id); setListType(type || "shopping"); setListName(name || ""); setScreen("add"); };
      const goHome = () => { navHistoryRef.current = [{ screen: "home" }]; pushNav({ screen: "home" }); setScreen("home"); setListId(null); };
      const goBack = () => window.history.back();

      return (
        <div className="max-w-md mx-auto min-h-screen relative">
          {simulateRegular && (
            <button onClick={() => toggleSimulate(false)}
              className="fixed top-2 left-1/2 -translate-x-1/2 z-50 bg-black/70 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5">
              <span>👁️ תצוגת משתמש רגיל</span><span className="opacity-70">· חזרה למנהל</span>
            </button>
          )}
          {screen === "home"       && <HomeScreen       user={user} isAdmin={role === "admin" && !simulateRegular} isRealAdmin={role === "admin"} simulating={simulateRegular} onToggleSimulate={toggleSimulate} onOpenList={goList} onCategories={() => go("categories")} onContacts={() => go("contacts")} showToast={setToast} onAddTask={() => goAdd("tasks_" + user.uid, "tasks")} onCreateShoppingList={(id, name) => goAdd(id, "shopping", name)} onCreateNotesList={(id, name) => goAdd(id, "notes", name)} />}
          {screen === "list"       && <ListScreen       user={user} listId={listId} onBack={goBack} onAdd={(type, name) => goAdd(listId, type, name || listName)} showToast={setToast} />}
          {screen === "add"        && <AddScreen        user={user} listId={listId} listType={listType} listName={listName} onBack={goBack} showToast={setToast} showStickyToast={setStickyToast} />}
          {screen === "categories" && <CategoriesScreen user={user} onBack={goBack} showToast={setToast} />}
          {screen === "contacts"   && <ContactsScreen   user={user} onBack={goBack} showToast={setToast} />}
          {toast && <Toast msg={toast} onClose={() => setToast("")} />}
          {stickyToast.length > 0 && (
            <div onClick={() => setStickyToast([])}
              className="fixed bottom-24 left-1/2 -translate-x-1/2 w-11/12 max-w-md bg-amber-50 border border-amber-300 rounded-2xl px-4 py-3 z-50 shadow-lg cursor-pointer">
              <p className="font-semibold text-amber-800 text-sm mb-1">כבר קיים ברשימה:</p>
              <p className="text-amber-700 text-sm leading-relaxed">{stickyToast.join(" · ")}</p>
              <p className="text-xs text-amber-400 text-center mt-2">לחץ לסגירה</p>
            </div>
          )}
        </div>
      );
    }

    // ── LOGIN ─────────────────────────────────────────────────────────────────────
    function LoginScreen() {
      const [err, setErr] = useState("");
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-blue-50 to-white px-6">
          <div className="text-8xl mb-4">🛒</div>
          <h1 className="text-5xl font-bold text-blue-600 mb-1">בולי</h1>
          <p className="text-gray-300 text-xs mb-10">{VERSION}</p>
          <p className="text-gray-400 mb-8 text-lg">רשימות קניות חכמות</p>
          <button onClick={() => auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()).catch(e => setErr(e.message))}
            className="bg-white border border-gray-200 shadow-md rounded-2xl px-8 py-4 flex items-center gap-3 text-gray-700 font-medium text-lg hover:shadow-lg transition">
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" />
            כניסה עם Google
          </button>
          {err && <p className="text-red-500 mt-4 text-sm text-center">{err}</p>}
        </div>
      );
    }

    // ── NOT AUTHORIZED ────────────────────────────────────────────────────────────
    function NotAuthorizedScreen({ user }) {
      return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-blue-50 to-white px-6 text-center">
          <div className="text-6xl mb-4">🔒</div>
          <h1 className="text-2xl font-bold text-gray-800 mb-2">אין לך גישה לבולי</h1>
          <p className="text-gray-500 mb-1">מחובר כ־{user.email}</p>
          <p className="text-gray-400 text-sm mb-8 leading-relaxed">בקש מהמנהל להוסיף אותך תחת הגדרות ← ניהול משתמשים</p>
          <button onClick={() => auth.signOut()}
            className="bg-white border border-gray-200 shadow-md rounded-2xl px-6 py-3 text-gray-600 font-medium">
            התנתק
          </button>
        </div>
      );
    }

    // ── HOME ──────────────────────────────────────────────────────────────────────
    function HomeScreen({ user, isAdmin, isRealAdmin, simulating, onToggleSimulate, onOpenList, onCategories, onContacts, showToast, onAddTask, onCreateShoppingList, onCreateNotesList }) {
      const tasksListId = "tasks_" + user.uid;
      const [lists,      setLists]      = useState(function() { return homeDataCache ? homeDataCache.lists : null; });
      const [tasks,      setTasks]      = useState(function() { return homeDataCache ? homeDataCache.tasks : null; });
      // Every local mutation of `lists` must also update homeDataCache, or the
      // next "back to menu" reuses the pre-mutation snapshot (prewarmHomeData
      // only re-fetches when the cache is empty) — this was why adding/removing
      // a list looked like it needed a full page reload to actually show up.
      const updateLists = function(updater) {
        setLists(function(prev) {
          var next = typeof updater === "function" ? updater(prev) : updater;
          if (homeDataCache) homeDataCache = Object.assign({}, homeDataCache, { lists: next });
          return next;
        });
      };
      const [loadError,  setLoadError]  = useState(null);
      const [editTask,   setEditTask]   = useState(null);
      const [menuId,     setMenuId]     = useState(null);
      const [showDone,   setShowDone]   = useState(false);
      const [renameId,   setRenameId]   = useState(null);
      const [renameName, setRenameName] = useState("");

      const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      const _isInstalled = window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone;
      const [canInstall, setCanInstall] = useState(!_isInstalled && (!!window.__installPrompt || _isIOS));
      const [showInstallGuide, setShowInstallGuide] = useState(false);

      const [majorListId, setMajorListIdState] = useState(function() {
        try { var m = JSON.parse(localStorage.getItem("buli_major_list")); return m ? m.id : null; } catch(e) { return null; }
      });
      const [showShortcutGuide, setShowShortcutGuide] = useState(false);
      const [showSettings, setShowSettings] = useState(false);
      const [showAISettings, setShowAISettings] = useState(false);
      const [notesSeparator, setNotesSeparator] = useState(function() { return localStorage.getItem("buli_notes_separator") || "הבא"; });
      const [editingNoteInstance, setEditingNoteInstance] = useState(null);
      const [aiProvider,   setAiProvider]   = useState("anthropic");
      const [openaiKey,    setOpenaiKey]    = useState("");
      const [geminiKey,    setGeminiKey]    = useState("");
      const [anthropicKey, setAnthropicKey] = useState("");
      const [aiModel,      setAiModel]      = useState(getAIModel("anthropic"));
      const [aiPrompt,     setAiPrompt]     = useState(DEFAULT_AI_PROMPT);
      const switchProvider = (p) => { setAiProvider(p); setAiModel(getAIModel(p)); setLiveModelsErr(""); };
      const [promptOpen, setPromptOpen] = useState(false);

      // Live model catalog for the active provider, fetched on demand — the
      // hardcoded defaultModel above goes stale as providers ship new models.
      const [liveModels, setLiveModels] = useState({});      // { [provider]: { models, cheapestId } }
      const [liveModelsLoading, setLiveModelsLoading] = useState(false);
      const [liveModelsErr, setLiveModelsErr] = useState("");
      const currentProviderKey = () => (aiProvider === "openai" ? openaiKey : aiProvider === "gemini" ? geminiKey : anthropicKey);
      const refreshModels = () => {
        var key = currentProviderKey();
        if (!key.trim() || liveModelsLoading) return;
        setLiveModelsLoading(true);
        setLiveModelsErr("");
        fns.httpsCallable("listProviderModels")({ provider: aiProvider, apiKey: key.trim() }).then(function(res) {
          setLiveModels(function(m) { var next = Object.assign({}, m); next[aiProvider] = res.data; return next; });
          setLiveModelsLoading(false);
        }).catch(function(e) {
          setLiveModelsErr(e.message);
          setLiveModelsLoading(false);
        });
      };
      const modelLabel = (m, cheapestId) => {
        var price = m.price ? (" — $" + m.price.in + "/$" + m.price.out + " למיליון") : "";
        var cheap = m.id === cheapestId ? " · 💰 הכי זול" : "";
        return (m.label || m.id) + price + cheap;
      };
      // Always include the currently-selected model, even if it fell out of
      // the live/fallback list, so the <select> never silently blanks it.
      const modelOptions = (models, currentId) => {
        if (currentId && !models.some(function(m) { return m.id === currentId; })) {
          return [{ id: currentId, label: currentId }].concat(models);
        }
        return models;
      };

      // ── Price comparison vendor profiles (own preference, admin controls
      // the on/off flag and the max-active-at-once cap) ──
      const [myPricingEnabled, setMyPricingEnabled] = useState(false);
      const [showPricingSettings, setShowPricingSettings] = useState(false);
      const [pricingBranchesLoading, setPricingBranchesLoading] = useState(false);
      const [vendorBranchLists, setVendorBranchLists] = useState(function() {
        var o = {}; VENDOR_IDS.forEach(function(v) { o[v] = null; }); return o;
      });
      // { [profileId]: { vendor, branchId, active } } — every branch the user
      // has ever added, not just the active ones (that's server-enforced).
      const [vendorProfiles, setVendorProfiles] = useState({});
      const [maxActiveVendors, setMaxActiveVendors] = useState(3);
      const [newProfileVendorInput, setNewProfileVendorInput] = useState("");
      const [newProfileBranchId, setNewProfileBranchId] = useState("");
      const [vendorRequestSent, setVendorRequestSent] = useState(false);
      const [branchSearchQuery, setBranchSearchQuery] = useState("");
      const [showVendorRequests, setShowVendorRequests] = useState(false);
      const [vendorRequestsLoading, setVendorRequestsLoading] = useState(false);
      const [vendorRequestsList, setVendorRequestsList] = useState([]);

      useEffect(function() {
        var profilesRef = null;
        var onProfiles = null;
        db.ref("users/" + user.uid + "/pricingEnabled").once("value").then(function(snap) {
          var enabled = !!snap.val();
          setMyPricingEnabled(enabled);
          if (!enabled) return; // no pricing for this user — skip the vendor-profile listener and settings call entirely
          profilesRef = db.ref("users/" + user.uid + "/vendorProfiles");
          onProfiles = function(snap2) { setVendorProfiles(snap2.val() || {}); };
          profilesRef.on("value", onProfiles);
          fns.httpsCallable("getPricingSettings")().then(function(res) {
            setMaxActiveVendors((res.data && res.data.maxActiveVendors) || 3);
          }).catch(function() {});
        });
        return function() { if (profilesRef && onProfiles) profilesRef.off("value", onProfiles); };
      }, [user.uid]);

      const activeVendorProfileCount = Object.values(vendorProfiles).filter(function(p) { return p && p.active; }).length;

      const loadVendorBranches = function() {
        setPricingBranchesLoading(true);
        Promise.all(VENDOR_IDS.map(function(id) { return fns.httpsCallable("getVendorBranches")({ vendor: id }); }))
          .then(function(results) {
            var next = {};
            VENDOR_IDS.forEach(function(id, i) { next[id] = results[i].data.branches || {}; });
            setVendorBranchLists(next);
            setPricingBranchesLoading(false);
          }, function() { setPricingBranchesLoading(false); });
      };

      const requestVendorSupport = function(name) {
        fns.httpsCallable("requestVendor")({ name: name }).then(function() {
          setVendorRequestSent(true);
          showToast("הבקשה נשלחה למנהל");
        }).catch(function() { showToast("שגיאה בשליחת הבקשה"); });
      };

      const loadVendorRequests = function() {
        setVendorRequestsLoading(true);
        fns.httpsCallable("listVendorRequests")().then(function(res) {
          setVendorRequestsList((res.data && res.data.requests) || []);
          setVendorRequestsLoading(false);
        }, function() { setVendorRequestsLoading(false); });
      };

      const dismissVendorRequest = function(id) {
        setVendorRequestsList(function(prev) { return prev.filter(function(r) { return r.id !== id; }); });
        fns.httpsCallable("dismissVendorRequest")({ id: id }).catch(function() { showToast("שגיאה במחיקת הבקשה"); });
      };

      const addVendorProfile = function(vendor, branchId) {
        if (!vendor || !branchId) return;
        var alreadySaved = Object.values(vendorProfiles).some(function(p) { return p && p.vendor === vendor && String(p.branchId) === String(branchId); });
        if (alreadySaved) { showToast("הסניף כבר ברשימה שלך"); return; }
        db.ref("users/" + user.uid + "/vendorProfiles").push({ vendor: vendor, branchId: branchId, active: false, addedAt: Date.now() });
        setNewProfileVendorInput(""); setVendorRequestSent(false);
        setNewProfileBranchId("");
      };

      const removeVendorProfile = function(profileId) {
        db.ref("users/" + user.uid + "/vendorProfiles/" + profileId).remove();
      };

      const toggleVendorProfileActive = function(profileId) {
        var p = vendorProfiles[profileId];
        if (!p) return;
        if (!p.active && activeVendorProfileCount >= maxActiveVendors) {
          showToast("ניתן להשוות עד " + maxActiveVendors + " סניפים בו-זמנית");
          return;
        }
        db.ref("users/" + user.uid + "/vendorProfiles/" + profileId + "/active").set(!p.active);
      };

      const saveMaxActiveVendors = function(value) {
        var n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1 || n > 10) return;
        setMaxActiveVendors(n);
        fns.httpsCallable("setMaxActiveVendors")({ value: n }).catch(function() { showToast("שגיאה בשמירת המגבלה"); });
      };
      const API_KEY_LINKS = {
        anthropic: "https://console.anthropic.com/settings/keys",
        openai:    "https://platform.openai.com/api-keys",
        gemini:    "https://aistudio.google.com/apikey"
      };

      // ── Manage Users (admin only) ──────────────────────────────────────────────
      const [showUsers,   setShowUsers]   = useState(false);
      const [usersLoading, setUsersLoading] = useState(false);
      const [authUsers,   setAuthUsers]   = useState([]);
      const [ownerEmail,  setOwnerEmail]  = useState("");
      const [ownerPricingEnabled, setOwnerPricingEnabled] = useState(false);
      const [ownerNickname, setOwnerNickname] = useState("");
      const [ownerLastLogin, setOwnerLastLogin] = useState(null);
      const [newUserEmail, setNewUserEmail] = useState("");
      const [newUserRole,  setNewUserRole]  = useState("user");
      const [userBusy,    setUserBusy]    = useState(false);
      const [userMsg,     setUserMsg]     = useState("");

      const loadAuthUsers = () => {
        setUsersLoading(true);
        fns.httpsCallable("listAuthorizedUsers")().then(function(res) {
          setOwnerEmail(res.data.owner || "");
          setOwnerPricingEnabled(!!res.data.ownerPricingEnabled);
          setOwnerNickname(res.data.ownerNickname || "");
          setOwnerLastLogin(res.data.ownerLastLogin || null);
          setAuthUsers(res.data.users || []);
          setUsersLoading(false);
        }, function(e) {
          setUserMsg("⚠ " + e.message);
          setUsersLoading(false);
        });
      };
      const handleAddUser = () => {
        var email = newUserEmail.trim();
        if (!email || userBusy) return;
        setUserBusy(true); setUserMsg("");
        fns.httpsCallable("addAuthorizedUser")({ email: email, role: newUserRole }).then(function() {
          setNewUserEmail(""); setNewUserRole("user"); setUserMsg("✓ נוסף"); setUserBusy(false);
          loadAuthUsers();
        }, function(e) { setUserMsg("⚠ " + e.message); setUserBusy(false); });
      };
      const handleRemoveUser = (email) => {
        if (!window.confirm("להסיר גישה מ־" + email + "?")) return;
        setUserBusy(true);
        fns.httpsCallable("removeAuthorizedUser")({ email: email }).then(function() {
          setUserBusy(false);
          loadAuthUsers();
        }, function(e) { setUserMsg("⚠ " + e.message); setUserBusy(false); });
      };
      const handleChangeRole = (email, newRole) => {
        setUserBusy(true); setUserMsg("");
        fns.httpsCallable("addAuthorizedUser")({ email: email, role: newRole }).then(function() {
          setUserMsg("✓ התפקיד עודכן"); setUserBusy(false);
          loadAuthUsers();
        }, function(e) { setUserMsg("⚠ " + e.message); setUserBusy(false); });
      };
      const handleTogglePricing = (email, nextEnabled) => {
        setUserBusy(true); setUserMsg("");
        fns.httpsCallable("setUserPricingEnabled")({ email: email, enabled: nextEnabled }).then(function() {
          setUserBusy(false);
          loadAuthUsers();
        }, function(e) { setUserMsg("⚠ " + e.message); setUserBusy(false); });
      };
      const handleSaveNickname = (email, nickname) => {
        setUserBusy(true); setUserMsg("");
        fns.httpsCallable("setUserNickname")({ email: email, nickname: nickname }).then(function() {
          setUserBusy(false);
          loadAuthUsers();
        }, function(e) { setUserMsg("⚠ " + e.message); setUserBusy(false); });
      };

      // ── Usage & Costs ────────────────────────────────────────────────────────
      const [showCosts,    setShowCosts]    = useState(false);
      const [costsLoading, setCostsLoading] = useState(false);
      const [myCosts,      setMyCosts]      = useState(null);
      const [allCosts,     setAllCosts]     = useState(null);
      const [costsMsg,     setCostsMsg]     = useState("");

      const loadCosts = () => {
        setCostsLoading(true); setCostsMsg("");
        var call = isAdmin ? fns.httpsCallable("getCosts")({ scope: "all" }) : fns.httpsCallable("getCosts")();
        call.then(function(res) {
          if (isAdmin) setAllCosts(res.data.users || []); else setMyCosts(res.data.costs || {});
          setCostsLoading(false);
        }, function(e) { setCostsMsg("⚠ " + e.message); setCostsLoading(false); });
      };
      var userCostTotal = function(costs) {
        return Object.values(costs || {}).reduce(function(sum, byProvider) {
          return sum + Object.values(byProvider || {}).reduce(function(s, v) { return s + v; }, 0);
        }, 0);
      };
      var formatUsd = function(n) { return "$" + (n || 0).toFixed(4); };
      var formatBytes = function(n) {
        n = n || 0;
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / (1024 * 1024)).toFixed(2) + " MB";
      };

      // ── Loaded vendor catalogs (pricing feature) — admin only, view + prune ────
      const [showVendorCatalogs, setShowVendorCatalogs] = useState(false);
      const [vendorCatalogsLoading, setVendorCatalogsLoading] = useState(false);
      const [vendorCatalogsList, setVendorCatalogsList] = useState([]);
      const loadVendorCatalogs = () => {
        setVendorCatalogsLoading(true);
        fns.httpsCallable("listVendorCatalogs")().then(function(res) {
          setVendorCatalogsList((res.data && res.data.entries) || []);
          setVendorCatalogsLoading(false);
        }, function() { setVendorCatalogsLoading(false); });
      };
      const deleteVendorCatalogEntry = function(vendor, branchId) {
        setVendorCatalogsList(function(prev) { return prev.filter(function(e) { return !(e.vendor === vendor && e.branchId === branchId); }); });
        fns.httpsCallable("deleteVendorCatalog")({ vendor: vendor, branchId: branchId }).catch(function() { showToast("שגיאה במחיקה"); });
      };

      // ── Firebase usage (pricing feature) — admin only, own estimate ────────────
      const [showFirebaseUsage, setShowFirebaseUsage] = useState(false);
      const [firebaseUsageLoading, setFirebaseUsageLoading] = useState(false);
      const [firebaseUsageMonths, setFirebaseUsageMonths] = useState(null);
      const loadFirebaseUsage = () => {
        setFirebaseUsageLoading(true);
        fns.httpsCallable("getPricingUsage")().then(function(res) {
          setFirebaseUsageMonths(res.data.months || []);
          setFirebaseUsageLoading(false);
        }, function() { setFirebaseUsageLoading(false); });
      };

      const [confirmDialog, setConfirmDialog] = useState(null);
      const [autoOpenMajor, setAutoOpenMajorState] = useState(localStorage.getItem("buli_auto_open_major") === "true");
      const [userColor,        setUserColor]        = useState(function() { return getUserColor(user.uid); });
      const [showColorPicker,  setShowColorPicker]  = useState(false);
      const changeUserColor = function(color) {
        localStorage.setItem("buli_user_color_" + user.uid, color);
        setUserColor(color);
        setShowColorPicker(false);
        db.ref("users/" + user.uid + "/color").set(color);
      };
      const [activeTab, setActiveTab] = useState(function() { return localStorage.getItem("buli_active_tab") || "shopping"; });
      const setTab = function(t) { setActiveTab(t); localStorage.setItem("buli_active_tab", t); };
      const toggleAutoOpen = () => {
        var next = !autoOpenMajor;
        localStorage.setItem("buli_auto_open_major", next ? "true" : "false");
        setAutoOpenMajorState(next);
        showToast(next ? "הרשימה הראשית תיפתח אוטומטית 🚀" : "הפעלה אוטומטית כבויה");
      };

      // AI settings are per-person — each person's own key lives at
      // users/{uid}/ai and is only ever sent to the parseItems Cloud Function, never to a
      // third-party API directly from the browser.
      const saveAISettings = () => {
        if (aiProvider === "openai"    && !openaiKey.trim())    { showToast("נדרש מפתח OpenAI — הזן מפתח או בחר ספק אחר"); return; }
        if (aiProvider === "gemini"    && !geminiKey.trim())    { showToast("נדרש מפתח Gemini — הזן מפתח או בחר ספק אחר"); return; }
        if (aiProvider === "anthropic" && !anthropicKey.trim()) { showToast("נדרש מפתח Claude — הזן מפתח או בחר ספק אחר"); return; }
        var model = aiModel.trim() || AI_PROVIDERS[aiProvider].defaultModel;
        var settings = {
          provider: aiProvider,
          openaiApiKey:    openaiKey.trim(),
          openaiModel:     aiProvider === "openai"    ? model : AI_PROVIDERS.openai.defaultModel,
          geminiApiKey:    geminiKey.trim(),
          geminiModel:     aiProvider === "gemini"    ? model : AI_PROVIDERS.gemini.defaultModel,
          anthropicApiKey: anthropicKey.trim(),
          anthropicModel:  aiProvider === "anthropic" ? model : AI_PROVIDERS.anthropic.defaultModel,
          prompt:          aiPrompt !== DEFAULT_AI_PROMPT ? aiPrompt : null
        };
        db.ref("users/" + user.uid + "/ai").set(settings).then(function() {
          showToast("הגדרות AI נשמרו");
        }, function() { showToast("שגיאה בשמירה"); });
        setShowAISettings(false);
      };

      useEffect(function() {
        db.ref("users/" + user.uid + "/ai").once("value").then(function(snap) {
          var s = snap.val();
          if (!s) return;
          var p = (s.provider === "openai" || s.provider === "gemini" || s.provider === "anthropic") ? s.provider : "anthropic";
          setAiProvider(p);
          setOpenaiKey(s.openaiApiKey || "");
          setGeminiKey(s.geminiApiKey || "");
          setAnthropicKey(s.anthropicApiKey || "");
          var savedModel = s[p + "Model"];
          var RETIRED_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-3-flash-preview"];
          if (savedModel && RETIRED_MODELS.indexOf(savedModel) !== -1) savedModel = null;
          setAiModel(savedModel || getAIModel(p));
          setAiPrompt(s.prompt || DEFAULT_AI_PROMPT);
        });
      }, [user.uid]);

      const setMajor = (id, name) => {
        localStorage.setItem("buli_major_list", JSON.stringify({ id: id, name: name }));
        setMajorListIdState(id);
        setMenuId(null);
        showToast("רשימה ראשית הוגדרה ⭐");
      };

      useEffect(function() {
        function onReady() { setCanInstall(true); }
        function onDone()  { setCanInstall(false); }
        window.addEventListener('pwa_install_ready', onReady);
        window.addEventListener('pwa_installed',     onDone);
        return function() {
          window.removeEventListener('pwa_install_ready', onReady);
          window.removeEventListener('pwa_installed',     onDone);
        };
      }, []);

      const installApp = () => {
        if (window.__installPrompt) {
          window.__installPrompt.prompt();
          window.__installPrompt.userChoice.then(function(r) {
            if (r.outcome === 'accepted') { setCanInstall(false); window.__installPrompt = null; }
          });
        } else {
          setShowInstallGuide(true);
        }
      };

      const loadHome = function() {
        setLoadError(null);
        // App() already kicked this off the moment the uid was known, in
        // parallel with the getMyRole round-trip — by the time HomeScreen
        // mounts (which waits on role), this is often already done or close
        // to it, instead of only starting now. If a cached view already
        // exists (returning from a list/other screen within the same
        // session), this resolves instantly with no spinner.
        withTimeout(prewarmHomeData(user.uid), 12000, "תם הזמן הקצוב לחיבור").then(function(data) {
          setLists(data.lists);
          setTasks(data.tasks);
          // Auto-set major if there's only one active shopping list and none is set
          var active = data.lists.filter(function(l) { return !l.done && l.type !== "notes"; });
          if (active.length === 1) {
            try {
              var existing = JSON.parse(localStorage.getItem("buli_major_list"));
              if (!existing) { localStorage.setItem("buli_major_list", JSON.stringify({ id: active[0].id, name: active[0].name })); setMajorListIdState(active[0].id); }
            } catch(e) { localStorage.setItem("buli_major_list", JSON.stringify({ id: active[0].id, name: active[0].name })); setMajorListIdState(active[0].id); }
          }
        }, function(err) {
          // Without this, a dropped connection (far more common on flaky mobile
          // networks than on wired desktop) left lists/tasks at null forever —
          // an infinite "טוען רשימות..." spinner with no error and no retry.
          // The underlying prewarmHomeData call itself isn't cancelled: if it
          // eventually completes in the background, it still populates the
          // shared cache for next time.
          setLoadError((err && err.message) || "שגיאה בטעינת הרשימות");
        });
      };
      useEffect(function() { loadHome(); }, []);

      const quickCreate = () => {
        var prefix = "רשימת קניות #";
        var maxNum = 0;
        (lists || []).forEach(function(l) {
          if (l.name && l.name.indexOf(prefix) === 0) {
            var num = parseInt(l.name.substring(prefix.length), 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
        });
        var autoName = prefix + (maxNum + 1);
        var now = Date.now();
        var newList = { name: autoName, type: "shopping", isPrivate: false, done: false, ownerId: user.uid, ownerName: user.displayName, sharedWith: {}, createdAt: now };
        var newListId = db.ref("lists").push().key;
        db.ref().update({ ["lists/" + newListId]: newList, ["listsByUser/" + user.uid + "/" + newListId]: true }).then(function() {
          updateLists(function(prev) { return [Object.assign({ id: newListId }, newList)].concat(prev || []); });
          onCreateShoppingList(newListId, autoName);
        }, function() { showToast("שגיאה ביצירת הרשימה"); });
      };

      const quickCreateNote = () => {
        var prefix = "תפריט #";
        var maxNum = 0;
        (lists || []).filter(function(l) { return l.type === "notes"; }).forEach(function(l) {
          if (l.name && l.name.indexOf(prefix) === 0) {
            var num = parseInt(l.name.substring(prefix.length), 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
        });
        var autoName = prefix + (maxNum + 1);
        var now = Date.now();
        var lastDiners = parseInt(localStorage.getItem("buli_last_diners_count"), 10) || 12;
        var newList = { name: autoName, type: "notes", isPrivate: true, done: false, ownerId: user.uid, ownerName: user.displayName, sharedWith: {}, createdAt: now, dinnerDate: nextFriday(now), dinersCount: lastDiners };
        var newListId = db.ref("lists").push().key;
        db.ref().update({ ["lists/" + newListId]: newList, ["listsByUser/" + user.uid + "/" + newListId]: true }).then(function() {
          updateLists(function(prev) { return [Object.assign({ id: newListId }, newList)].concat(prev || []); });
          onCreateNotesList(newListId, autoName);
        }, function() { showToast("שגיאה ביצירת התפריט"); });
      };

      const reassignMajorIfNeeded = (newLists) => {
        var active = (newLists || []).filter(function(l) { return !l.done && l.type !== "notes"; });
        var currentMajorId = null;
        try { var m = JSON.parse(localStorage.getItem("buli_major_list")); currentMajorId = m ? m.id : null; } catch(e) {}
        if (active.some(function(l) { return l.id === currentMajorId; })) return;
        if (active.length > 0) {
          localStorage.setItem("buli_major_list", JSON.stringify({ id: active[0].id, name: active[0].name }));
          setMajorListIdState(active[0].id);
        } else {
          localStorage.removeItem("buli_major_list");
          setMajorListIdState(null);
        }
      };

      const markListDone = (id) => {
        var now = Date.now();
        var newLists = (lists || []).map(function(l) { return l.id === id ? Object.assign({}, l, { done: true, doneAt: now }) : l; });
        updateLists(newLists);
        reassignMajorIfNeeded(newLists);
        setMenuId(null); showToast("הרשימה סומנה כהושלמה");
        db.ref("lists/" + id).update({ done: true, doneAt: now });
      };

      const restoreList = (id) => {
        updateLists(function(prev) { return prev ? prev.map(function(l) { return l.id === id ? Object.assign({}, l, { done: false, doneAt: null }) : l; }) : []; });
        setMenuId(null);
        db.ref("lists/" + id).update({ done: false, doneAt: null });
      };

      const saveNoteInstance = function(id, name, date, dinersCount, note) {
        var count = parseInt(dinersCount, 10) || 12;
        localStorage.setItem("buli_last_diners_count", count);
        updateLists(function(prev) { return prev.map(function(l) { return l.id === id ? Object.assign({}, l, { name: name, dinnerDate: date, dinersCount: count, note: note }) : l; }); });
        db.ref("lists/" + id).update({ name: name.trim(), dinnerDate: date, dinersCount: count, note: note || "" });
        setEditingNoteInstance(null);
      };

      const deleteList = (id) => {
        setMenuId(null);
        var listObj = (lists || []).find(function(l) { return l.id === id; });
        setConfirmDialog({
          message: "למחוק את הרשימה וכל הפריטים שלה?",
          onConfirm: function() {
            var newLists = (lists || []).filter(function(l) { return l.id !== id; });
            updateLists(newLists);
            reassignMajorIfNeeded(newLists);
            showToast("הרשימה נמחקה");
            var updates = {};
            updates["lists/" + id] = null;
            updates["items/" + id] = null;
            updates["listsByUser/" + user.uid + "/" + id] = null;
            if (listObj && listObj.sharedWith) {
              Object.keys(listObj.sharedWith).forEach(function(uid) { updates["listsByUser/" + uid + "/" + id] = null; });
            }
            db.ref().update(updates);
          }
        });
      };

      const startRename = (id) => {
        var list = (lists || []).find(function(l) { return l.id === id; });
        setRenameId(id); setRenameName(list ? list.name : ""); setMenuId(null);
      };

      const confirmRename = () => {
        if (!renameName.trim() || !renameId) return;
        var newName = renameName.trim();
        updateLists(function(prev) { return prev ? prev.map(function(l) { return l.id === renameId ? Object.assign({}, l, { name: newName }) : l; }) : []; });
        db.ref("lists/" + renameId).update({ name: newName });
        setRenameId(null); showToast("שם הרשימה עודכן");
      };

      const togglePrivacy = (id) => {
        var list = (lists || []).find(function(l) { return l.id === id; });
        var nowPrivate = list ? !list.isPrivate : true;
        updateLists(function(prev) { return prev ? prev.map(function(l) { return l.id === id ? Object.assign({}, l, { isPrivate: nowPrivate }) : l; }) : []; });
        setMenuId(null);
        db.ref("lists/" + id).update({ isPrivate: nowPrivate });
        showToast(nowPrivate ? "הרשימה עכשיו פרטית 🔒" : "הרשימה עכשיו שיתופית 👥");
        if (!nowPrivate) {
          db.ref("shareDefaults").once("value").then(function(snap) {
            var val = snap.val() || {};
            Object.keys(val).forEach(function(uid) {
              if (val[uid] && uid !== user.uid) {
                db.ref().update({ ["lists/" + id + "/sharedWith/" + uid]: "edit", ["listsByUser/" + uid + "/" + id]: true });
              }
            });
          });
        }
      };

      const toggleTask = (task) => {
        var newDone = !task.done;
        var now = Date.now();
        setTasks(function(prev) { return prev ? prev.map(function(t) { return t.id === task.id ? Object.assign({}, t, { done: newDone, completedAt: newDone ? now : null }) : t; }) : []; });
        db.ref("items/" + tasksListId + "/" + task.id).update({ done: newDone, completedAt: newDone ? now : null });
      };

      const saveTaskEdit = (updated) => {
        setTasks(function(prev) { return prev ? prev.map(function(t) { return t.id === updated.id ? Object.assign({}, t, updated) : t; }) : []; });
        setEditTask(null);
        db.ref("items/" + tasksListId + "/" + updated.id).update({
          name: updated.name, note: updated.note || "", dueDate: updated.dueDate || ""
        }).then(function() { showToast("מטלה עודכנה"); }, function(err) { showToast("שגיאה: " + (err && err.message || "?")); });
      };

      const deleteTask = (id) => {
        setTasks(function(prev) { return prev ? prev.filter(function(t) { return t.id !== id; }) : []; });
        setEditTask(null);
        db.ref("items/" + tasksListId + "/" + id).remove();
        showToast("מטלה נמחקה");
      };

      if (lists === null || tasks === null) return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <div className="bg-blue-600 text-white px-4 pt-10 pb-5 flex-shrink-0">
            <div className="flex items-center justify-between" dir="ltr">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🛒</span>
                <span className="text-xl font-bold">בולי</span>
                <span className="text-xs text-white/40">{VERSION}</span>
              </div>
              <button onClick={() => auth.signOut()} className="text-xs bg-white/20 px-3 py-1.5 rounded-full">יציאה</button>
            </div>
            <p className="text-white/60 text-sm mt-2 text-right">שלום, {user.displayName.split(" ")[0]}</p>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
            {loadError ? (
              <React.Fragment>
                <span className="text-4xl">⚠️</span>
                <p className="text-sm text-gray-500 text-center">לא הצלחנו לטעון את הרשימות.<br/>בדקו את החיבור לאינטרנט ונסו שוב.</p>
                <button onClick={loadHome} className="bg-blue-600 text-white px-5 py-2 rounded-full text-sm font-medium">נסה שוב</button>
              </React.Fragment>
            ) : (
              <React.Fragment>
                <CartLoader />
                <p className="text-sm text-gray-400">טוען רשימות...</p>
              </React.Fragment>
            )}
          </div>
        </div>
      );

      const shareApp = () => {
        var url = 'https://buli-8fdf9.web.app';
        if (navigator.share) {
          navigator.share({ title: 'בולי - רשימות קניות', text: 'נסה את בולי — רשימות קניות חכמות עם AI 🛒', url: url });
        } else {
          navigator.clipboard.writeText(url).then(function() { showToast('הקישור הועתק! 🔗'); }, function() { showToast(url); });
        }
      };

      var byDate = function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); };
      var activeShopping = lists.filter(function(l) { return !l.done && l.type !== "notes"; }).sort(byDate);
      var doneLists      = lists.filter(function(l) { return  l.done && l.type !== "notes"; }).sort(byDate);
      var byDinnerDate   = function(a, b) { return (b.dinnerDate || "").localeCompare(a.dinnerDate || ""); };
      var activeNotes    = lists.filter(function(l) { return !l.done && l.type === "notes"; }).sort(byDinnerDate);
      var doneNotes      = lists.filter(function(l) { return  l.done && l.type === "notes"; }).sort(byDinnerDate);
      var sortTasksByDue = function(arr) {
        return arr.slice().sort(function(a, b) {
          var ad = a.dueDate || "", bd = b.dueDate || "";
          if (!ad && !bd) return (a.createdAt || 0) - (b.createdAt || 0);
          if (!ad) return 1; if (!bd) return -1;
          return ad > bd ? 1 : ad < bd ? -1 : 0;
        });
      };
      var pendingTasks   = sortTasksByDue(tasks.filter(function(t) { return !t.done; }));
      var doneTasks      = sortTasksByDue(tasks.filter(function(t) { return  t.done; }));


      var cardProps = function(l) { return {
        key: l.id, list: l, userId: user.uid,
        onOpen: function() { onOpenList(l.id, l.name); },
        menuOpen: menuId === l.id,
        onMenuToggle: function(e) { e.stopPropagation(); setMenuId(menuId === l.id ? null : l.id); },
        onMarkDone:      function() { markListDone(l.id); },
        onRestore:       function() { restoreList(l.id); },
        onTogglePrivacy: function() { togglePrivacy(l.id); },
        onRename:        function() { startRename(l.id); },
        onDelete:        function() { deleteList(l.id); },
        isMajor:         majorListId === l.id,
        onSetMajor:      function() { setMajor(l.id, l.name); },
        onShowShortcut:  function(e) { e.stopPropagation(); setMenuId(null); setShowShortcutGuide(true); }
      }; };

      var noteCardProps = function(l) { return {
        key: l.id, list: l, userId: user.uid,
        onOpen: function() { onOpenList(l.id, l.name); },
        menuOpen: menuId === l.id,
        onMenuToggle: function(e) { e.stopPropagation(); setMenuId(menuId === l.id ? null : l.id); },
        onMarkDone:  function() { markListDone(l.id); },
        onRestore:   function() { restoreList(l.id); },
        onDelete:    function() { deleteList(l.id); },
        onEdit:      function() { setMenuId(null); setEditingNoteInstance({ id: l.id, name: l.name || "", date: l.dinnerDate || nextFriday(l.createdAt || Date.now()), dinersCount: l.dinersCount || parseInt(localStorage.getItem("buli_last_diners_count"), 10) || 12, note: l.note || "" }); }
      }; };

      return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}} onClick={() => setMenuId(null)}>
          <div className="bg-blue-600 text-white px-4 pt-10 pb-3 flex-shrink-0">
            <div className="flex items-center justify-between" dir="ltr">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🛒</span>
                <span className="text-xl font-bold">בולי</span>
                <span className="text-xs text-white/40">{VERSION}</span>
              </div>
              <button onClick={e => { e.stopPropagation(); setShowSettings(true); }} className="text-white text-xl w-9 h-9 flex items-center justify-center bg-white/20 rounded-full">☰</button>
            </div>
            <p className="text-white/60 text-sm mt-1 text-right">שלום, {user.displayName.split(" ")[0]}</p>
          </div>
          <div className="bg-white border-b border-gray-200 flex-shrink-0 flex" dir="rtl">
            {[["shopping","🛒","קניות"],["notes","📝","תפריטים"],["tasks","✅","מטלות"]].map(function(t) {
              var id = t[0], icon = t[1], label = t[2];
              return (
                <button key={id} onClick={function(e) { e.stopPropagation(); setTab(id); }}
                  className={"flex-1 py-2.5 flex flex-col items-center gap-0.5 border-b-2 transition " + (activeTab===id ? "text-blue-600 border-blue-600 font-semibold" : "text-gray-400 border-transparent")}>
                  <span className="text-base">{icon}</span>
                  <span className="text-xs">{label}</span>
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-4 pb-24">

            {/* ── Shopping tab ── */}
            {activeTab === "shopping" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <button onClick={e => { e.stopPropagation(); quickCreate(); }} className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-full shadow">+ רשימה חדשה</button>
                </div>
                {activeShopping.length === 0
                  ? <p className="text-center text-gray-300 text-sm py-8">אין רשימות קניות — לחץ "+ רשימה חדשה"</p>
                  : <div className="space-y-2">{activeShopping.map(l => <ListCard {...cardProps(l)} />)}</div>
                }
                {doneLists.length > 0 && (
                  <div>
                    <button onClick={() => setShowDone(v => !v)} className="text-sm text-gray-400 flex items-center gap-1 mb-2 w-full justify-end">
                      <span>{showDone ? "▾" : "▸"}</span><span>הושלמו ({doneLists.length})</span>
                    </button>
                    {showDone && <div className="space-y-2 opacity-60">{doneLists.map(l => <ListCard {...cardProps(l)} isDone />)}</div>}
                  </div>
                )}
              </div>
            )}

            {/* ── Notes tab ── */}
            {activeTab === "notes" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <button onClick={e => { e.stopPropagation(); quickCreateNote(); }} className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-full shadow">+ תפריט חדש</button>
                </div>
                {activeNotes.length === 0
                  ? <p className="text-center text-gray-300 text-sm py-8">אין תפריטים — לחץ "+ תפריט חדש"</p>
                  : <div className="space-y-2">{activeNotes.map(l => <ListCard {...noteCardProps(l)} />)}</div>
                }
                {doneNotes.length > 0 && (
                  <div>
                    <button onClick={() => setShowDone(v => !v)} className="text-sm text-gray-400 flex items-center gap-1 mb-2 w-full justify-end">
                      <span>{showDone ? "▾" : "▸"}</span><span>הושלמו ({doneNotes.length})</span>
                    </button>
                    {showDone && <div className="space-y-2 opacity-60">{doneNotes.map(l => <ListCard {...noteCardProps(l)} isDone />)}</div>}
                  </div>
                )}
              </div>
            )}

            {/* ── Tasks tab ── */}
            {activeTab === "tasks" && (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <button onClick={e => { e.stopPropagation(); onAddTask(); }} className="bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-full shadow">+ מטלה חדשה</button>
                </div>
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-1">
                  {pendingTasks.length === 0 && doneTasks.length === 0 ? (
                    <p className="text-center text-gray-300 text-sm py-6">אין מטלות — לחץ "+ מטלה חדשה"</p>
                  ) : (
                    <>
                      {pendingTasks.map(function(task) {
                        return <HomeTaskRow key={task.id} task={task} onToggle={toggleTask} onTap={function() { setEditTask(Object.assign({}, task)); }} />;
                      })}
                      {doneTasks.length > 0 && (
                        <div className="border-t border-gray-50 mt-1">
                          <p className="text-xs text-gray-300 py-2 text-center">הושלם ({doneTasks.length})</p>
                          {doneTasks.map(function(task) {
                            return <HomeTaskRow key={task.id} task={task} onToggle={toggleTask} onTap={function() { setEditTask(Object.assign({}, task)); }} />;
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {editTask && <TaskEditModal item={editTask} onChange={setEditTask} onSave={saveTaskEdit} onDelete={deleteTask} onClose={() => setEditTask(null)} />}

          {/* Rename modal */}
          {renameId && (
            <Modal onClose={() => setRenameId(null)}>
              <h3 className="text-lg font-bold text-center mb-4">שינוי שם</h3>
              <input value={renameName} onChange={e => setRenameName(e.target.value)} autoFocus
                onKeyDown={e => e.key === "Enter" && confirmRename()}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400 mb-4" />
              <button onClick={confirmRename} disabled={!renameName.trim()}
                className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold text-lg disabled:opacity-40">
                שמור
              </button>
            </Modal>
          )}

          {/* Settings modal */}
          {showSettings && (
            <Modal onClose={() => setShowSettings(false)}>
              <div className="mb-5 pb-4 border-b border-gray-100">
                <div className="flex items-center gap-3">
                  {user.photoURL
                    ? <img src={user.photoURL} className="w-10 h-10 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
                    : <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600 font-bold flex-shrink-0">{(user.displayName || "?")[0]}</div>
                  }
                  <div className="flex-1 text-right">
                    <p className="font-semibold text-gray-800">{user.displayName}</p>
                    <p className="text-xs text-gray-400">{user.email}</p>
                  </div>
                  <button onClick={function() { setShowColorPicker(function(v) { return !v; }); }}
                    style={{background: userColor}}
                    className="w-8 h-8 rounded-full flex-shrink-0 border-2 border-white shadow-md"
                    title="שנה צבע" />
                </div>
                {showColorPicker && (
                  <div className="mt-3">
                    <p className="text-xs text-gray-400 mb-2 text-right">הצבע שלי — גלוי לכולם ברשימות משותפות</p>
                    <div className="flex gap-2 flex-wrap">
                      {USER_COLORS.map(function(c) {
                        return (
                          <button key={c} onClick={function() { changeUserColor(c); }}
                            style={{background: c, outline: userColor === c ? "3px solid " + c : "none", outlineOffset: "2px"}}
                            className="w-8 h-8 rounded-full shadow transition-transform hover:scale-110" />
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              {isRealAdmin && (
                <button onClick={function() { setShowSettings(false); onToggleSimulate(!simulating); }}
                  className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3 mb-2 bg-gray-50">
                  <span className="text-lg w-7 text-center">👁️</span>
                  <span className="flex-1">{simulating ? "חזרה לתצוגת מנהל" : "צפה כמשתמש רגיל"}</span>
                  {simulating && <span className="text-xs text-blue-500 font-semibold">פעיל</span>}
                </button>
              )}
              <div className="space-y-1">
                {canInstall && (
                  <button onClick={function() { setShowSettings(false); installApp(); }} className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3">
                    <span className="text-lg w-7 text-center">📲</span><span>התקן אפליקציה</span>
                  </button>
                )}
                <button onClick={function() { setShowSettings(false); shareApp(); }} className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3">
                  <span className="text-lg w-7 text-center">🔗</span><span>שתף את בולי</span>
                </button>
                <button onClick={function() { setShowSettings(false); setShowShortcutGuide(true); }} className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3">
                  <span className="text-lg w-7 text-center">📱</span><span>קיצור דרך לרשימה ראשית</span>
                </button>
                <button onClick={toggleAutoOpen} className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3">
                  <span className="text-lg w-7 text-center">🚀</span>
                  <span className="flex-1">פתח רשימה ראשית בהפעלה</span>
                  <span className={`w-11 h-6 rounded-full transition-colors flex-shrink-0 flex items-center px-0.5 ${autoOpenMajor ? "bg-blue-500" : "bg-gray-300"}`}>
                    <span className={`w-5 h-5 bg-white rounded-full shadow transition-transform ${autoOpenMajor ? "translate-x-5" : "translate-x-0"}`} />
                  </span>
                </button>
                <div className="border-t border-gray-100 my-1" />
                <button onClick={function() { setShowSettings(false); onContacts(); }} className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3">
                  <span className="text-lg w-7 text-center">👥</span><span>אנשי קשר</span>
                </button>
                <button onClick={function() { setShowSettings(false); onCategories(); }} className="w-full text-right px-3 py-3 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3">
                  <span className="text-lg w-7 text-center">⚙️</span><span>קטגוריות וחנויות</span>
                </button>
                <div className="px-3 py-2.5 flex items-center gap-3">
                  <span className="text-lg w-7 text-center">📝</span>
                  <span className="flex-1 text-sm text-gray-700">מילת מעבר בתפריטים</span>
                  <input value={notesSeparator} onChange={function(e) {
                    var val = e.target.value;
                    setNotesSeparator(val);
                    if (val.trim()) localStorage.setItem("buli_notes_separator", val.trim());
                  }} dir="rtl" maxLength={20}
                    className="w-20 border border-gray-200 rounded-lg px-2 py-1 text-sm text-center focus:outline-none focus:border-blue-400 text-gray-700" />
                </div>
              </div>

              {/* ── AI Provider ─────────────────────────────────────────────────── */}
              <div className="mt-4">
                <button onClick={function() { setShowAISettings(function(o) { return !o; }); }}
                  className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showAISettings ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                  <div className="flex items-center gap-3">
                    <span className="text-lg w-7 text-center">🤖</span>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-gray-700">הגדרות AI</div>
                      <div className="text-xs text-gray-400">{AI_PROVIDERS[aiProvider].name}</div>
                    </div>
                  </div>
                  <span className="text-gray-400 text-xs flex-shrink-0">{showAISettings ? "▲ הסתר" : "▼ הצג"}</span>
                </button>
                {showAISettings && (
                  <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                    <div>
                        <p className="text-xs text-gray-500 mb-2 text-right">ספק AI</p>
                        <div className="grid grid-cols-3 gap-2 mb-4">
                          {Object.entries(AI_PROVIDERS).map(function(entry) {
                            var id = entry[0], p = entry[1];
                            var hasKey = !!(id === "openai" ? openaiKey : id === "gemini" ? geminiKey : anthropicKey);
                            var active = aiProvider === id;
                            return (
                              <button key={id} onClick={function() { switchProvider(id); }}
                                className={"py-2 rounded-xl text-sm font-medium border transition flex flex-col items-center gap-0.5 " + (active ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200")}>
                                <span className="font-semibold">{p.name} {hasKey ? "✓" : ""}</span>
                                <span className={"text-xs " + (active ? "text-blue-100" : "text-gray-400")}>{p.label}{p.free ? " · חינם" : ""}</span>
                              </button>
                            );
                          })}
                        </div>

                        {[["anthropic", "Anthropic API Key", anthropicKey, setAnthropicKey, "sk-ant-..."],
                          ["openai", "OpenAI API Key", openaiKey, setOpenaiKey, "sk-..."],
                          ["gemini", "Google AI Studio API Key", geminiKey, setGeminiKey, "AIza..."]]
                          .filter(function(row) { return row[0] === aiProvider; })
                          .map(function(row) {
                            var id = row[0], label = row[1], val = row[2], setter = row[3], ph = row[4];
                            return (
                              <div key={id} className="mb-3">
                                <div className="flex items-center justify-between mb-1">
                                  <a href={API_KEY_LINKS[id]} target="_blank" rel="noopener noreferrer"
                                    className="text-xs font-semibold text-blue-500 bg-blue-50 border border-blue-100 rounded-lg px-2 py-1 whitespace-nowrap">
                                    🔑 קבל מפתח API ↗
                                  </a>
                                  <p className="text-xs text-gray-500 text-right">{label}</p>
                                </div>
                                <input value={val} onChange={function(e) { setter(e.target.value); }} placeholder={ph} type="password" dir="ltr"
                                  className="w-full border border-gray-200 rounded-xl px-4 py-3 text-left focus:outline-none focus:border-blue-400 text-sm" />
                              </div>
                            );
                          })}

                        <div className="mb-4">
                          <div className="flex items-center justify-between mb-1">
                            <button onClick={refreshModels} disabled={!currentProviderKey().trim() || liveModelsLoading}
                              className="text-xs font-semibold text-blue-500 bg-blue-50 border border-blue-100 rounded-lg px-2 py-1 whitespace-nowrap disabled:opacity-40">
                              {liveModelsLoading ? "בודק..." : "🔄 רענן רשימה"}
                            </button>
                            <p className="text-xs text-gray-500 text-right">מודל</p>
                          </div>
                          <select value={aiModel} onChange={function(e) { setAiModel(e.target.value); }} dir="ltr"
                            className="w-full border border-gray-200 rounded-xl px-4 py-3 text-left focus:outline-none focus:border-blue-400 text-sm font-mono bg-white">
                            {modelOptions((liveModels[aiProvider] && liveModels[aiProvider].models) || FALLBACK_MODELS[aiProvider], aiModel).map(function(m) {
                              return <option key={m.id} value={m.id}>{modelLabel(m, liveModels[aiProvider] && liveModels[aiProvider].cheapestId)}</option>;
                            })}
                          </select>
                          {liveModelsErr ? (
                            <p className="text-xs text-red-500 mt-1 text-right">{liveModelsErr}</p>
                          ) : liveModels[aiProvider] ? (
                            <p className="text-xs text-gray-400 mt-1 text-right">נמצאו {liveModels[aiProvider].models.length} מודלים בחשבון שלך.</p>
                          ) : (
                            <p className="text-xs text-gray-400 mt-1 text-right">רשימת ברירת מחדל — לחץ "רענן רשימה" למודלים העדכניים מהחשבון שלך.</p>
                          )}
                        </div>

                        <button onClick={function() { setPromptOpen(function(o) { return !o; }); }}
                          className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 rounded-xl text-xs text-gray-500 mb-2">
                          <span>{promptOpen ? "▲ הסתר" : "▼ הצג"}</span>
                          <span>פרומפט מותאם אישית</span>
                        </button>
                        {promptOpen && (
                          <div className="mb-4">
                            <div className="flex items-center justify-between mb-1">
                              <button onClick={function() { setAiPrompt(DEFAULT_AI_PROMPT); }} className="text-xs text-blue-500">אפס</button>
                              <p className="text-xs text-gray-500">פרומפט ({"{categories}"} = רשימת קטגוריות, {"{text}"} = הטקסט)</p>
                            </div>
                            <textarea value={aiPrompt} onChange={function(e) { setAiPrompt(e.target.value); }} rows={8} dir="rtl"
                              className="w-full border border-gray-200 rounded-xl p-3 text-xs font-mono resize-none focus:outline-none focus:border-blue-400" />
                          </div>
                        )}
                    </div>
                    <button onClick={saveAISettings} className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold">שמור</button>
                  </div>
                )}
              </div>

              {/* ── Price comparison branches ───────────────────────────────────── */}
              {myPricingEnabled && (
                <div className="mt-4">
                  <button onClick={function() { setShowPricingSettings(function(o) { if (!o && !vendorBranchLists.ramiLevy) loadVendorBranches(); return !o; }); }}
                    className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showPricingSettings ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg w-7 text-center">💰</span>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-gray-700">רשתות מזון להשוואת מחירים</div>
                        <div className="text-xs text-gray-400">הסניפים שלי</div>
                      </div>
                    </div>
                    <span className="text-gray-400 text-xs flex-shrink-0">{showPricingSettings ? "▲ הסתר" : "▼ הצג"}</span>
                  </button>
                  {showPricingSettings && (
                    <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                      {pricingBranchesLoading ? (
                        <div className="flex justify-center py-6"><Spinner /></div>
                      ) : (
                        <div className="space-y-5">
                          <div className="text-xs text-gray-400 text-center">
                            פעילים להשוואה: {activeVendorProfileCount} / {maxActiveVendors}
                          </div>
                          {Object.entries(vendorProfiles).length > 0 && (
                            <div className="space-y-1.5">
                              {Object.entries(vendorProfiles).map(function(entry) {
                                var pid = entry[0], p = entry[1];
                                var meta = VENDOR_LIST.find(function(x) { return x.id === p.vendor; });
                                var info = (vendorBranchLists[p.vendor] || {})[p.branchId] || {};
                                return (
                                  <div key={pid} className={"flex items-center justify-between rounded-xl px-3 py-2 border " + (p.active ? "bg-green-50 border-green-200" : "bg-gray-50 border-transparent")}>
                                    <div className="text-xs text-gray-700 flex-1 text-right">
                                      <span className="font-semibold">{meta ? meta.label : p.vendor}</span>
                                      {" — "}{info.name || ("סניף " + parseInt(p.branchId, 10))}{info.address ? " — " + info.address : ""}
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      <button onClick={function() { toggleVendorProfileActive(pid); }}
                                        className={"text-xs border rounded-full px-2 py-0.5 " + (p.active ? "text-green-600 border-green-200 bg-white" : "text-gray-400 border-gray-200 bg-white")}>
                                        {p.active ? "פעיל" : "כבוי"}
                                      </button>
                                      <button onClick={function() { removeVendorProfile(pid); }} className="text-gray-300 hover:text-red-500 text-sm px-1">✕</button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div className="border-t border-gray-100 pt-3">
                            <div className="text-xs font-semibold text-gray-500 mb-1.5">הוסף סניף להשוואה</div>
                            <input list="vendor-name-suggestions" value={newProfileVendorInput}
                              onChange={function(e) { setNewProfileVendorInput(e.target.value); setNewProfileBranchId(""); setVendorRequestSent(false); setBranchSearchQuery(""); }}
                              placeholder="הקלד שם רשת, למשל: רמי לוי" dir="rtl"
                              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white mb-2" />
                            <datalist id="vendor-name-suggestions">
                              {VENDOR_NAME_SUGGESTIONS.map(function(name) { return <option key={name} value={name} />; })}
                            </datalist>
                            {(function() {
                              var trimmed = newProfileVendorInput.trim();
                              var matched = VENDOR_LIST.find(function(v) { return v.label === trimmed; });
                              var q = branchSearchQuery.trim().toLowerCase();
                              var branchEntries = matched ? Object.entries(vendorBranchLists[matched.id] || {})
                                .filter(function(entry) {
                                  if (!q) return true;
                                  var hay = ((entry[1].name || "") + " " + (entry[1].address || "") + " " + (entry[1].city || "") + " " + entry[0]).toLowerCase();
                                  return hay.indexOf(q) !== -1;
                                })
                                .sort(function(a, b) { return (a[1].name||"").localeCompare(b[1].name||"", "he"); }) : [];
                              return (
                                <div>
                                  {matched && (
                                    <input value={branchSearchQuery} onChange={function(e) { setBranchSearchQuery(e.target.value); }}
                                      placeholder="חפש סניף לפי שם או עיר..." dir="rtl"
                                      className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white mb-2" />
                                  )}
                                  <div className="flex gap-2">
                                    <select value={newProfileBranchId} disabled={!matched} onChange={function(e) { setNewProfileBranchId(e.target.value); }}
                                      className="flex-1 min-w-0 border border-gray-200 rounded-xl px-3 py-2 text-sm bg-white disabled:bg-gray-50 disabled:text-gray-400">
                                      <option value="">
                                        {!matched ? "הקלד רשת קודם" : branchEntries.length > 0 ? "בחר סניף... (" + branchEntries.length + ")" : "לא נמצאו סניפים"}
                                      </option>
                                      {branchEntries.map(function(entry) {
                                        return <option key={entry[0]} value={entry[0]}>{entry[1].name} — {entry[1].address} (סניף {parseInt(entry[0], 10)})</option>;
                                      })}
                                    </select>
                                    <button onClick={function() { addVendorProfile(matched.id, newProfileBranchId); }} disabled={!matched || !newProfileBranchId}
                                      className="bg-blue-600 text-white text-sm px-3 py-2 rounded-xl font-medium disabled:opacity-40 flex-shrink-0">+ הוסף</button>
                                  </div>
                                  {trimmed && !matched && (
                                    <div className="bg-orange-50 border border-orange-100 rounded-xl p-3 text-xs text-orange-700 space-y-2 mt-2">
                                      <div>"{trimmed}" עדיין לא נתמכת בבולי.</div>
                                      {vendorRequestSent ? (
                                        <div className="text-green-600 font-medium">הבקשה נשלחה למנהל ✓</div>
                                      ) : (
                                        <button onClick={function() { requestVendorSupport(trimmed); }}
                                          className="text-orange-700 font-medium border border-orange-200 bg-white rounded-lg px-3 py-1.5">
                                          בקש מהמנהל להוסיף את הרשת
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          {isAdmin && (
                            <div className="pt-3 border-t border-gray-100 flex items-center justify-between">
                              <div className="text-xs font-semibold text-gray-500">מגבלת סניפים פעילים (מנהל)</div>
                              <input type="number" min="1" max="10" value={maxActiveVendors}
                                onChange={function(e) { saveMaxActiveVendors(e.target.value); }}
                                className="w-16 border border-gray-200 rounded-xl px-2 py-1.5 text-sm text-center" />
                            </div>
                          )}
                          {isAdmin && (
                            <div className="pt-3 border-t border-gray-100">
                              <button onClick={function() { setShowVendorRequests(function(o) { if (!o) loadVendorRequests(); return !o; }); }}
                                className="w-full flex items-center justify-between text-xs font-semibold text-gray-500">
                                <span>בקשות לרשתות חדשות (מנהל)</span>
                                <span className="text-gray-400">{showVendorRequests ? "▲ הסתר" : "▼ הצג"}</span>
                              </button>
                              {showVendorRequests && (
                                <div className="mt-2 space-y-1.5">
                                  {vendorRequestsLoading ? (
                                    <div className="flex justify-center py-4"><Spinner /></div>
                                  ) : vendorRequestsList.length === 0 ? (
                                    <p className="text-center text-gray-400 text-xs py-2">אין בקשות פתוחות</p>
                                  ) : vendorRequestsList.map(function(r) {
                                    return (
                                      <div key={r.id} className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2">
                                        <div className="text-xs text-gray-700 flex-1 text-right">
                                          <span className="font-semibold">{r.name}</span>
                                          <div className="text-gray-400 mt-0.5">{r.requestedBy} · {formatRefreshTime(r.requestedAt)}</div>
                                        </div>
                                        <button onClick={function() { dismissVendorRequest(r.id); }} className="text-gray-300 hover:text-red-500 text-sm px-1 flex-shrink-0">✕</button>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Manage Users (admin only) ───────────────────────────────────── */}
              {isAdmin && (
                <div className="mt-3">
                  <button onClick={function() { setShowUsers(function(o) { if (!o) loadAuthUsers(); return !o; }); }}
                    className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showUsers ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg w-7 text-center">🔑</span>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-gray-700">ניהול משתמשים</div>
                        <div className="text-xs text-gray-400">מי יכול להשתמש בבולי</div>
                      </div>
                    </div>
                    <span className="text-gray-400 text-xs flex-shrink-0">{showUsers ? "▲ הסתר" : "▼ הצג"}</span>
                  </button>
                  {showUsers && (
                    <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                      {usersLoading ? (
                        <div className="flex justify-center py-6"><Spinner /></div>
                      ) : (
                        <div>
                          <div className="bg-gray-50 rounded-xl px-3 py-2 mb-2">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm text-gray-700 truncate">{ownerEmail}</span>
                              <span className="text-xs font-bold text-green-500 uppercase flex-shrink-0">בעלים</span>
                            </div>
                            <div className="text-xs text-gray-400 mb-1.5">
                              {ownerLastLogin ? "התחבר לאחרונה: " + formatRefreshTime(ownerLastLogin) : "מעולם לא התחבר"}
                            </div>
                            <div className="flex items-center gap-2">
                              <input key={"owner:" + ownerNickname} type="text" defaultValue={ownerNickname}
                                placeholder="כינוי (יוצג ברשימת שיתוף)" dir="rtl" disabled={userBusy}
                                onBlur={function(e) { var v = e.target.value.trim(); if (v !== ownerNickname) handleSaveNickname(ownerEmail, v); }}
                                className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:border-blue-400" />
                              <button onClick={function() { handleTogglePricing(ownerEmail, !ownerPricingEnabled); }} disabled={userBusy} title="השוואת מחירים"
                                className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (ownerPricingEnabled ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                                💰{ownerPricingEnabled ? "" : "🚫"}
                              </button>
                            </div>
                          </div>
                          {authUsers.length === 0 ? (
                            <p className="text-xs text-gray-400 px-3 py-2 mb-2">אין עדיין משתמשים נוספים</p>
                          ) : authUsers.map(function(u) {
                            return (
                              <div key={u.email} className="bg-gray-50 rounded-xl px-3 py-2 mb-2">
                                <div className="flex items-center justify-between mb-1.5">
                                  <span className="text-sm text-gray-700 truncate">{u.email}</span>
                                  <button onClick={function() { handleRemoveUser(u.email); }} disabled={userBusy}
                                    className="text-xs text-red-500 border border-red-200 rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0">הסר</button>
                                </div>
                                <div className="text-xs text-gray-400 mb-1.5">
                                  {u.lastLogin ? "התחבר לאחרונה: " + formatRefreshTime(u.lastLogin) : "מעולם לא התחבר"}
                                </div>
                                <div className="flex items-center gap-2">
                                  <input key={u.email + ":" + (u.nickname || "")} type="text" defaultValue={u.nickname || ""}
                                    placeholder="כינוי (יוצג ברשימת שיתוף)" dir="rtl" disabled={userBusy}
                                    onBlur={function(e) { var v = e.target.value.trim(); if (v !== (u.nickname || "")) handleSaveNickname(u.email, v); }}
                                    className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:border-blue-400" />
                                  <select value={u.role} disabled={userBusy}
                                    onChange={function(e) { handleChangeRole(u.email, e.target.value); }}
                                    className={"text-xs font-bold uppercase border rounded-lg px-1.5 py-1 bg-white flex-shrink-0 " + (u.role === "admin" ? "text-blue-500 border-blue-200" : "text-gray-500 border-gray-200")}>
                                    <option value="user">User</option>
                                    <option value="admin">Admin</option>
                                  </select>
                                  <button onClick={function() { handleTogglePricing(u.email, !u.pricingEnabled); }} disabled={userBusy} title="השוואת מחירים עבור המשתמש הזה"
                                    className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (u.pricingEnabled ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                                    💰{u.pricingEnabled ? "" : "🚫"}
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                          <div className="flex gap-2 mt-3">
                            <input type="email" value={newUserEmail} onChange={function(e) { setNewUserEmail(e.target.value); }}
                              placeholder="name@example.com" dir="ltr"
                              className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-left focus:outline-none focus:border-blue-400"
                              onKeyDown={function(e) { if (e.key === "Enter") handleAddUser(); }} />
                            <select value={newUserRole} onChange={function(e) { setNewUserRole(e.target.value); }}
                              className="border border-gray-200 rounded-xl px-2 py-2 text-sm">
                              <option value="user">User</option>
                              <option value="admin">Admin</option>
                            </select>
                          </div>
                          <button onClick={handleAddUser} disabled={!newUserEmail.trim() || userBusy}
                            className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold mt-3 disabled:opacity-40">הוסף</button>
                          {userMsg && <p className={"text-xs text-center mt-2 " + (userMsg.indexOf("✓") === 0 ? "text-green-500" : "text-red-500")}>{userMsg}</p>}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Usage & Costs ────────────────────────────────────────────────── */}
              <div className="mt-3 mb-2">
                <button onClick={function() { setShowCosts(function(o) { if (!o) loadCosts(); return !o; }); }}
                  className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showCosts ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                  <div className="flex items-center gap-3">
                    <span className="text-lg w-7 text-center">💰</span>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-gray-700">עלויות AI</div>
                      <div className="text-xs text-gray-400">{isAdmin ? "ההוצאות של כולם" : "ההוצאות שלך"}</div>
                    </div>
                  </div>
                  <span className="text-gray-400 text-xs flex-shrink-0">{showCosts ? "▲ הסתר" : "▼ הצג"}</span>
                </button>
                {showCosts && (
                  <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                    {costsLoading ? (
                      <div className="flex justify-center py-6"><Spinner /></div>
                    ) : isAdmin ? (
                      (allCosts || []).length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">אין עדיין נתוני שימוש</p>
                      ) : (
                        <div>
                          {[].concat(allCosts).sort(function(a, b) { return userCostTotal(b.costs) - userCostTotal(a.costs); }).map(function(u) {
                            return (
                              <div key={u.uid} className="bg-gray-50 rounded-xl px-3 py-2 mb-2">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm text-gray-700 truncate">{u.email || u.uid}</span>
                                  <span className="text-sm font-bold text-green-500 flex-shrink-0 ml-2">{formatUsd(userCostTotal(u.costs))}</span>
                                </div>
                                {Object.entries(u.costs || {}).sort(function(a, b) { return b[0].localeCompare(a[0]); }).map(function(entry) {
                                  var month = entry[0], byProvider = entry[1];
                                  return (
                                    <div key={month} className="flex items-center justify-between text-xs text-gray-400 border-t border-gray-200 pt-1 mt-1">
                                      <span>{month}</span>
                                      <span>{Object.entries(byProvider || {}).map(function(p) { return p[0] + ": " + formatUsd(p[1]); }).join(" · ")}</span>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                          <p className="text-xs text-gray-400 text-left mt-2">סה"כ: {formatUsd(allCosts.reduce(function(s, u) { return s + userCostTotal(u.costs); }, 0))}</p>
                        </div>
                      )
                    ) : (
                      !myCosts || Object.keys(myCosts).length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">אין עדיין נתוני שימוש</p>
                      ) : (
                        <div className="bg-gray-50 rounded-xl px-3 py-2">
                          {Object.entries(myCosts).sort(function(a, b) { return b[0].localeCompare(a[0]); }).map(function(entry) {
                            var month = entry[0], byProvider = entry[1];
                            return (
                              <div key={month} className="flex items-center justify-between text-sm text-gray-700 border-t border-gray-200 first:border-t-0 py-1.5">
                                <span>{month}</span>
                                <span className="text-xs text-gray-400">{Object.entries(byProvider || {}).map(function(p) { return p[0] + ": " + formatUsd(p[1]); }).join(" · ")}</span>
                              </div>
                            );
                          })}
                          <p className="text-xs text-gray-400 text-left mt-2 pt-2 border-t border-gray-200">סה"כ: {formatUsd(userCostTotal(myCosts))}</p>
                        </div>
                      )
                    )}
                    {costsMsg && <p className="text-xs text-red-500 text-center mt-2">{costsMsg}</p>}
                  </div>
                )}
              </div>

              {/* ── Firebase usage (pricing feature, admin only) ─────────────────── */}
              {isAdmin && (
                <div className="mt-3 mb-2">
                  <button onClick={function() { setShowFirebaseUsage(function(o) { if (!o) loadFirebaseUsage(); return !o; }); }}
                    className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showFirebaseUsage ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg w-7 text-center">🔥</span>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-gray-700">שימוש ב-Firebase (השוואת מחירים)</div>
                        <div className="text-xs text-gray-400">הערכה גסה, לא החיוב המדויק</div>
                      </div>
                    </div>
                    <span className="text-gray-400 text-xs flex-shrink-0">{showFirebaseUsage ? "▲ הסתר" : "▼ הצג"}</span>
                  </button>
                  {showFirebaseUsage && (
                    <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                      {firebaseUsageLoading ? (
                        <div className="flex justify-center py-6"><Spinner /></div>
                      ) : !firebaseUsageMonths || firebaseUsageMonths.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">אין עדיין נתוני שימוש</p>
                      ) : (
                        <div>
                          {firebaseUsageMonths.map(function(m) {
                            return (
                              <div key={m.month} className="bg-gray-50 rounded-xl px-3 py-2 mb-2">
                                <div className="flex items-center justify-between mb-1">
                                  <span className="text-sm text-gray-700">{m.month}</span>
                                  <span className="text-sm font-bold text-green-500">≈${m.estimatedUsd.toFixed(3)}</span>
                                </div>
                                <div className="text-xs text-gray-400 space-y-0.5">
                                  <div>רענוני קטלוג מלאים: {m.catalogRefreshCount} ({formatBytes(m.catalogWriteBytes)} נכתבו)</div>
                                  <div>חיפושי מוצר חדש: {m.catalogReadCount} ({formatBytes(m.catalogReadBytes)} נקראו)</div>
                                  <div>בדיקות מחיר לפריט קיים: {m.pointReadCount} (זניח)</div>
                                </div>
                              </div>
                            );
                          })}
                          <p className="text-xs text-gray-400 text-center mt-1">
                            הערכה בלבד, מבוססת על נפח הנתונים בפועל — לא שאילתה מול חשבון החיוב של Google
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── Loaded vendor catalogs (pricing feature, admin only) ─────────── */}
              {isAdmin && (
                <div className="mt-3 mb-2">
                  <button onClick={function() { setShowVendorCatalogs(function(o) { if (!o) loadVendorCatalogs(); return !o; }); }}
                    className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showVendorCatalogs ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg w-7 text-center">📦</span>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-gray-700">סניפים שנטענו (מנהל)</div>
                        <div className="text-xs text-gray-400">צפייה ומחיקה של קטלוגים שמורים</div>
                      </div>
                    </div>
                    <span className="text-gray-400 text-xs flex-shrink-0">{showVendorCatalogs ? "▲ הסתר" : "▼ הצג"}</span>
                  </button>
                  {showVendorCatalogs && (
                    <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                      {vendorCatalogsLoading ? (
                        <div className="flex justify-center py-6"><Spinner /></div>
                      ) : vendorCatalogsList.length === 0 ? (
                        <p className="text-xs text-gray-400 text-center py-4">אין עדיין סניפים טעונים</p>
                      ) : (
                        <div className="space-y-1.5">
                          {vendorCatalogsList.map(function(e) {
                            var meta = VENDOR_LIST.find(function(v) { return v.id === e.vendor; });
                            return (
                              <div key={e.vendor + ":" + e.branchId} className="flex items-center justify-between bg-gray-50 rounded-xl px-3 py-2">
                                <div className="text-xs text-gray-700 flex-1 text-right">
                                  <span className="font-semibold">{meta ? meta.label : e.vendor}</span>
                                  {" — "}{e.name || ("סניף " + parseInt(e.branchId, 10))}
                                  <div className="text-gray-400 mt-0.5">
                                    {formatBytes(e.sizeBytes)} · {e.itemCount} מוצרים · עודכן: {e.updatedAt ? formatRefreshTime(e.updatedAt) : "?"}
                                  </div>
                                </div>
                                <button onClick={function() {
                                  if (!window.confirm("למחוק את הקטלוג של " + (meta ? meta.label : e.vendor) + " — " + (e.name || e.branchId) + "?")) return;
                                  deleteVendorCatalogEntry(e.vendor, e.branchId);
                                }} className="text-gray-300 hover:text-red-500 text-sm px-1 flex-shrink-0">🗑️</button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="border-t border-gray-100 my-2" />
              <button onClick={function() { auth.signOut(); }} className="w-full text-right px-3 py-3 text-sm text-red-500 hover:bg-red-50 rounded-xl flex items-center gap-3">
                <span className="text-lg w-7 text-center">🚪</span><span>יציאה</span>
              </button>
            </Modal>
          )}

          {/* Shortcut guide — device-aware */}
          {showShortcutGuide && (function() {
            var ua = navigator.userAgent || "";
            var isIOS = /iPhone|iPad|iPod/i.test(ua) && !window.MSStream;
            var isAndroid = /Android/i.test(ua);
            var isSamsung = isAndroid && /Samsung|SM-[A-Z]/i.test(ua);
            var copyUrl = function() {
              navigator.clipboard.writeText("https://buli-8fdf9.web.app/?open=major").then(function() { showToast("הקישור הועתק! 🔗"); }, function() { showToast("העתק: buli-8fdf9.web.app/?open=major"); });
            };
            var urlBox = (
              <div className="bg-blue-50 rounded-2xl px-4 py-3 mb-4 flex items-center justify-between gap-2">
                <span className="text-xs text-blue-500 font-mono break-all">buli-8fdf9.web.app/?open=major</span>
                <button onClick={copyUrl} className="bg-blue-600 text-white text-xs px-3 py-1.5 rounded-xl flex-shrink-0 font-semibold">העתק</button>
              </div>
            );
            var androidSteps = isSamsung ? (
              <div className="space-y-2 mb-4">
                <div className="bg-yellow-50 border border-yellow-200 rounded-2xl px-4 py-3">
                  <p className="font-semibold text-gray-800 text-sm mb-2">Samsung Galaxy — כפתור הצד</p>
                  <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                    <li>פתח <strong>הגדרות</strong> ← <strong>תכונות מתקדמות</strong> ← <strong>מקש הצד</strong></li>
                    <li>תחת "לחיצה כפולה" בחר <strong>הפעל אפליקציות מהירות</strong></li>
                    <li>בחר <strong>Chrome</strong> כאפליקציה</li>
                    <li>לחץ פעמיים על כפתור הצד ← Chrome נפתח ← הקלד את הכתובת</li>
                  </ol>
                  <p className="text-xs text-gray-400 mt-2">* לגישה מהירה יותר: הוסף קיצור דרך למסך הבית (ראה למטה)</p>
                </div>
                <div className="bg-gray-50 rounded-2xl px-4 py-3">
                  <p className="font-semibold text-gray-800 text-sm mb-2">קיצור דרך במסך הבית (הכי קל)</p>
                  <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                    <li>העתק את הקישור למעלה</li>
                    <li>פתח <strong>Chrome</strong> ← הדבק בשורת הכתובת</li>
                    <li>תפריט ⋮ ← <strong>הוסף למסך הבית</strong></li>
                    <li>תן שם "בולי ראשי" ← לחץ <strong>הוסף</strong></li>
                  </ol>
                </div>
              </div>
            ) : (
              <div className="space-y-2 mb-4">
                <div className="bg-gray-50 rounded-2xl px-4 py-3">
                  <p className="font-semibold text-gray-800 text-sm mb-2">קיצור דרך במסך הבית</p>
                  <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                    <li>העתק את הקישור למעלה</li>
                    <li>פתח <strong>Chrome</strong> ← הדבק בשורת הכתובת</li>
                    <li>תפריט ⋮ ← <strong>הוסף למסך הבית</strong></li>
                    <li>תן שם "בולי ראשי" ← לחץ <strong>הוסף</strong></li>
                  </ol>
                </div>
              </div>
            );
            var iosSteps = (
              <div className="space-y-2 mb-4">
                <div className="bg-yellow-50 border border-yellow-200 rounded-2xl px-4 py-3">
                  <p className="font-semibold text-gray-800 text-sm mb-2">iPhone 15 ומעלה — כפתור הפעולה</p>
                  <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                    <li>פתח אפליקציית <strong>קיצורי דרך</strong></li>
                    <li>לחץ <strong>+</strong> ← <strong>הוסף פעולה</strong> ← חפש "פתח כתובת URL"</li>
                    <li>הדבק את הקישור ← שמור בשם "בולי ראשי"</li>
                    <li><strong>הגדרות</strong> ← <strong>כפתור פעולה</strong> ← <strong>קיצור דרך</strong> ← בחר "בולי ראשי"</li>
                  </ol>
                </div>
                <div className="bg-gray-50 rounded-2xl px-4 py-3">
                  <p className="font-semibold text-gray-800 text-sm mb-2">כל iPhone — הקשה על הגב</p>
                  <ol className="text-xs text-gray-600 space-y-1 list-decimal list-inside">
                    <li>צור קיצור דרך כנ"ל (שלבים 1–3)</li>
                    <li><strong>הגדרות</strong> ← <strong>נגישות</strong> ← <strong>מגע</strong> ← <strong>הקשה על הגב</strong></li>
                    <li>בחר <strong>הקשה כפולה</strong> ← <strong>קיצורי דרך</strong> ← "בולי ראשי"</li>
                  </ol>
                </div>
              </div>
            );
            return (
              <Modal onClose={() => setShowShortcutGuide(false)}>
                <h3 className="text-xl font-bold text-center mb-1">קיצור דרך לרשימה ראשית 📱</h3>
                <p className="text-sm text-gray-400 text-center mb-4">פתח את הרשימה הראשית ישירות מהטלפון</p>
                {urlBox}
                {isIOS ? iosSteps : androidSteps}
                <button onClick={() => setShowShortcutGuide(false)} className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold">הבנתי</button>
              </Modal>
            );
          })()}

          {confirmDialog && <ConfirmDialog message={confirmDialog.message} confirmLabel={confirmDialog.confirmLabel} onConfirm={confirmDialog.onConfirm} onClose={function() { setConfirmDialog(null); }} />}

          {editingNoteInstance && (
            <Modal onClose={function() { setEditingNoteInstance(null); }}>
              <h3 className="text-lg font-bold text-center mb-4">עריכת תפריט</h3>
              <div className="space-y-3 mb-4">
                <div>
                  <label className="text-xs text-gray-500 block mb-1 text-right">שם</label>
                  <input value={editingNoteInstance.name}
                    onChange={function(e) { setEditingNoteInstance(function(p) { return Object.assign({}, p, { name: e.target.value }); }); }}
                    dir="rtl" placeholder="שם התפריט" autoFocus
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1 text-right">תאריך ארוחה 📅</label>
                  <input type="date" value={editingNoteInstance.date}
                    onChange={function(e) { setEditingNoteInstance(function(p) { return Object.assign({}, p, { date: e.target.value }); }); }}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-400 text-center text-base" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1 text-right">מספר סועדים 👥</label>
                  <input type="number" min="1" max="999" value={editingNoteInstance.dinersCount}
                    onChange={function(e) { setEditingNoteInstance(function(p) { return Object.assign({}, p, { dinersCount: e.target.value }); }); }}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-400 text-center text-base" />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <InlineMic onText={function(t) { setEditingNoteInstance(function(p) { return Object.assign({}, p, { note: (p.note ? p.note + " " : "") + t }); }); }} />
                    <label className="text-xs text-gray-500">הערות</label>
                  </div>
                  <div className="relative">
                    <textarea value={editingNoteInstance.note || ""}
                      onChange={function(e) { setEditingNoteInstance(function(p) { return Object.assign({}, p, { note: e.target.value }); }); }}
                      dir="rtl" rows={3} placeholder="הערות (אופציונלי)"
                      className="w-full border border-gray-200 rounded-xl p-3 text-right resize-none focus:outline-none focus:border-blue-400 text-sm" />
                    {editingNoteInstance.note ? (
                      <button onClick={function() { setEditingNoteInstance(function(p) { return Object.assign({}, p, { note: "" }); }); }}
                        className="absolute left-2 top-2 text-gray-300 hover:text-gray-500 text-base leading-none">✕</button>
                    ) : null}
                  </div>
                </div>
              </div>
              <button onClick={function() { saveNoteInstance(editingNoteInstance.id, editingNoteInstance.name, editingNoteInstance.date, editingNoteInstance.dinersCount, editingNoteInstance.note); }}
                disabled={!editingNoteInstance.name.trim() || !editingNoteInstance.date}
                className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold disabled:opacity-40">
                שמור
              </button>
            </Modal>
          )}

          {/* iOS install guide */}
          {showInstallGuide && (
            <Modal onClose={() => setShowInstallGuide(false)}>
              <h3 className="text-xl font-bold text-center mb-1">הוסף למסך הבית 📲</h3>
              <p className="text-sm text-gray-400 text-center mb-5">בצע את הצעדים הבאים בספארי</p>
              <div className="space-y-3 mb-5">
                <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3">
                  <span className="text-2xl w-8 text-center flex-shrink-0">1</span>
                  <div>
                    <p className="font-semibold text-gray-800 text-sm">לחץ על כפתור השיתוף</p>
                    <p className="text-xs text-gray-400">הסמל <span className="font-bold">↑</span> בתחתית המסך</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3">
                  <span className="text-2xl w-8 text-center flex-shrink-0">2</span>
                  <div>
                    <p className="font-semibold text-gray-800 text-sm">גלול ובחר</p>
                    <p className="text-xs text-gray-400">"הוסף למסך הבית"</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3">
                  <span className="text-2xl w-8 text-center flex-shrink-0">3</span>
                  <div>
                    <p className="font-semibold text-gray-800 text-sm">לחץ "הוסף"</p>
                    <p className="text-xs text-gray-400">האפליקציה תופיע במסך הבית</p>
                  </div>
                </div>
              </div>
              <button onClick={() => setShowInstallGuide(false)} className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold">הבנתי</button>
            </Modal>
          )}
        </div>
      );
    }

    function ListCard({ list, userId, onOpen, menuOpen, onMenuToggle, onMarkDone, onRestore, onTogglePrivacy, onRename, onDelete, isDone, isMajor, onSetMajor, onShowShortcut, onEdit }) {
      const isOwner = list.ownerId === userId;
      var dateStr = list.dinnerDate
        ? formatDinnerDate(list.dinnerDate)
        : (list.createdAt ? (function(){ var d = new Date(list.createdAt); return d.getDate()+"/"+(d.getMonth()+1)+"/"+d.getFullYear(); })() : "");
      return (
        <div className="relative">
          <div className={`w-full bg-white rounded-2xl p-4 flex items-center gap-3 shadow-sm border transition cursor-pointer ${isMajor ? "border-yellow-300 bg-yellow-50/30" : "border-gray-100 hover:border-blue-200"}`} onClick={onOpen}>
            {isMajor && (
              <button onClick={onShowShortcut}
                className="text-lg flex-shrink-0 leading-none"
                title="רשימה ראשית — לחץ להגדרת קיצור דרך">⭐</button>
            )}
            <div className="flex-1 min-w-0 text-right">
              <div className={`font-semibold truncate ${isDone ? "line-through text-gray-400" : "text-gray-800"}`}>{list.name}</div>
              {list.dinnerDate ? (
                <>
                  <div className="flex items-center justify-between mt-0.5">
                    <span className="text-xs text-gray-400">{list.dinersCount ? <span>מספר סועדים <strong>{list.dinersCount}</strong></span> : null}</span>
                    <span className="text-xs text-gray-400">תאריך ארוחה <strong>{dateStr}</strong></span>
                  </div>
                  {list.note && <div className="text-xs text-gray-400 mt-0.5 text-right truncate">{list.note}</div>}
                  {isDone && <div className="text-xs text-gray-400 text-right">✓</div>}
                </>
              ) : (
                <div className="text-xs text-gray-400 mt-0.5 flex items-center gap-1.5 justify-end">
                  {dateStr && <span>{dateStr}</span>}
                  {isDone && <><span>·</span><span>✓</span></>}
                </div>
              )}
            </div>
            <button onClick={onMenuToggle} className="text-gray-400 text-xl px-1 hover:text-gray-600 flex-shrink-0">⋮</button>
          </div>
          {menuOpen && (
            <div className="absolute left-2 top-full mt-1 bg-white rounded-xl shadow-xl border border-gray-100 z-20 overflow-hidden min-w-44" onClick={e => e.stopPropagation()}>
              {!isDone && !isMajor && onSetMajor && (
                <button onClick={onSetMajor} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>⭐</span><span>הגדר כראשי</span>
                </button>
              )}
              {!isDone && isMajor && onShowShortcut && (
                <button onClick={onShowShortcut} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>📱</span><span>קיצור דרך לכפתור הצד</span>
                </button>
              )}
              {isOwner && onRename && (
                <button onClick={onRename} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>✏️</span><span>שנה שם</span>
                </button>
              )}
              {onEdit && (
                <button onClick={onEdit} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>✏️</span><span>עריכה</span>
                </button>
              )}
              {!isDone && onMarkDone && (
                <button onClick={onMarkDone} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>✅</span><span>סמן כהושלם</span>
                </button>
              )}
              {isDone && onRestore && (
                <button onClick={onRestore} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>↩️</span><span>החזר לפעיל</span>
                </button>
              )}
              {isOwner && onTogglePrivacy && (
                <button onClick={onTogglePrivacy} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>{list.isPrivate ? "👥" : "🔒"}</span>
                  <span>{list.isPrivate ? "הפוך לשיתופי" : "הפוך לפרטי"}</span>
                </button>
              )}
              <button onClick={onDelete} className="w-full text-right px-4 py-3 text-sm text-red-500 hover:bg-red-50 flex items-center gap-2 border-t border-gray-100">
                <span>🗑️</span><span>מחק</span>
              </button>
            </div>
          )}
        </div>
      );
    }

    function HomeTaskRow({ task, onToggle, onTap }) {
      return (
        <div className="flex items-center gap-3 py-3 border-b border-gray-50 last:border-0 cursor-pointer" onClick={onTap}>
          <span onClick={function(e) { e.stopPropagation(); onToggle(task); }}>
            <Checkbox checked={!!task.done} onChange={function() { onToggle(task); }} />
          </span>
          <div className="flex-1 min-w-0">
            <span className={"text-sm font-medium " + (task.done ? "line-through text-gray-400" : "text-gray-700")}>{task.name}</span>
            {task.dueDate ? <div className="text-xs text-blue-400">{formatDueDate(task.dueDate)}</div> : null}
            {task.note ? <div className="text-xs text-gray-400 truncate">{task.note}</div> : null}
          </div>
          <span className="text-gray-300 text-sm flex-shrink-0">›</span>
        </div>
      );
    }

    function InlineMic({ onText }) {
      var [rec, setRec] = React.useState(false);
      var stopRef = React.useRef(null);
      var heldRef = React.useRef(false);

      var startRec = function(e) {
        e.preventDefault(); e.stopPropagation();
        heldRef.current = true;
        setRec(true);
        function doStart() {
          if (!heldRef.current) return;
          stopRef.current = startSpeech({
            onResult: function(text, isFinal) { if (isFinal) onText(text); },
            onEnd:    function() { if (heldRef.current) { doStart(); } else { setRec(false); stopRef.current = null; } },
            onError:  function() { if (heldRef.current) { setTimeout(doStart, 100); } else { setRec(false); stopRef.current = null; } }
          });
        }
        doStart();
      };
      var stopRec = function(e) {
        e.stopPropagation();
        heldRef.current = false;
        if (stopRef.current) { stopRef.current(); stopRef.current = null; }
        setRec(false);
      };

      return (
        <button
          onPointerDown={startRec} onPointerUp={stopRec} onPointerCancel={stopRec}
          style={{ touchAction: "none", userSelect: "none" }}
          className={"w-14 h-14 rounded-full flex-shrink-0 flex items-center justify-center text-2xl transition select-none " + (rec ? "bg-red-500 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200")}>
          🎤
        </button>
      );
    }

    function NoteItemRow({ item, canEdit, onToggle, onDelete, onEdit, onSaveNote, onMoveUp, onMoveDown, isFirst, isLast }) {
      var [editingNote, setEditingNote] = React.useState(false);
      var [noteVal,     setNoteVal]     = React.useState(item.note || "");

      var openNote   = function(e) { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(true); };
      var saveNote   = function(e) { e.stopPropagation(); onSaveNote(item.id, noteVal.trim()); setEditingNote(false); };
      var cancelNote = function(e) { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(false); };

      return (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2.5">
            <Checkbox checked={!!item.done} onChange={function() { onToggle(item); }} />
            <div className="flex-1 min-w-0">
              <span className={"text-sm font-medium block " + (item.done ? "line-through text-gray-400" : "text-gray-800")}>{item.name}</span>
              {!editingNote && item.note ? (
                <div onClick={canEdit ? openNote : undefined}
                  className={"text-xs text-gray-400 mt-0.5 flex items-start gap-1 " + (canEdit ? "cursor-pointer hover:text-gray-600" : "")}>
                  <span className="flex-shrink-0">💬</span><span className="break-words">{item.note}</span>
                </div>
              ) : !editingNote && canEdit ? (
                <button onClick={openNote} className="text-xs text-gray-300 hover:text-gray-500 mt-0.5 flex items-center gap-0.5">
                  <span>💬</span><span>הוסף הערה</span>
                </button>
              ) : null}
            </div>
            {canEdit && (
              <div className="flex items-center gap-1 flex-shrink-0">
                <div className="flex flex-col gap-px">
                  <button onClick={onMoveUp} disabled={isFirst}
                    className="w-5 h-4 flex items-center justify-center text-gray-300 hover:text-blue-500 disabled:opacity-20 text-xs leading-none">▲</button>
                  <button onClick={onMoveDown} disabled={isLast}
                    className="w-5 h-4 flex items-center justify-center text-gray-300 hover:text-blue-500 disabled:opacity-20 text-xs leading-none">▼</button>
                </div>
                <button onClick={function() { onEdit(item); }} className="text-gray-300 hover:text-blue-400 text-sm px-0.5">✏️</button>
                <button onClick={function() { onDelete(item.id); }} className="text-gray-300 hover:text-red-400 text-base">🗑️</button>
              </div>
            )}
          </div>
          {editingNote && (
            <div className="px-3 pb-3 pt-1 border-t border-gray-50">
              <div className="relative">
                <textarea value={noteVal} onChange={function(e) { setNoteVal(e.target.value); }} autoFocus rows={2}
                  placeholder="הוסף הערה..." dir="rtl"
                  className="w-full text-sm border border-blue-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:border-blue-400 text-right" />
                {noteVal ? (
                  <button onClick={function() { setNoteVal(""); }} className="absolute left-2 top-2 text-gray-300 hover:text-gray-500 text-base leading-none">✕</button>
                ) : null}
              </div>
              <div className="flex gap-2 mt-1.5 items-center justify-start" dir="ltr">
                <button onClick={saveNote} className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded-lg font-medium">שמור</button>
                <button onClick={cancelNote} className="text-xs text-gray-400 px-3 py-1.5 rounded-lg border border-gray-200">ביטול</button>
                <InlineMic onText={function(t) { setNoteVal(function(prev) { return prev ? prev + " " + t : t; }); }} />
              </div>
            </div>
          )}
        </div>
      );
    }

    function NoteEditModal({ item, onSave, onClose }) {
      var [name, setName] = React.useState(item.name || "");
      var [note, setNote] = React.useState(item.note || "");
      return (
        <Modal onClose={onClose}>
          <h3 className="text-lg font-bold text-center mb-4">עריכת מנה</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1 text-right">שם המנה</label>
              <input value={name} onChange={function(e) { setName(e.target.value); }} dir="rtl" placeholder="שם המנה" autoFocus
                className="w-full border border-gray-200 rounded-xl p-3 text-right focus:outline-none focus:border-blue-400 text-sm" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <InlineMic onText={function(t) { setNote(function(prev) { return prev ? prev + " " + t : t; }); }} />
                <label className="text-xs text-gray-500">הערה</label>
              </div>
              <textarea value={note} onChange={function(e) { setNote(e.target.value); }} dir="rtl" placeholder="הערה (אופציונלי)" rows={3}
                className="w-full border border-gray-200 rounded-xl p-3 text-right resize-none focus:outline-none focus:border-blue-400 text-sm" />
            </div>
          </div>
          <button onClick={function() { if (name.trim()) onSave(name.trim(), note.trim()); }} disabled={!name.trim()}
            className="w-full mt-4 bg-blue-600 text-white py-3 rounded-xl font-semibold disabled:opacity-40">
            שמור
          </button>
        </Modal>
      );
    }

    // ── CONTACTS SCREEN ───────────────────────────────────────────────────────────
    function ContactsScreen({ user, onBack, showToast }) {
      // Roster comes from authorized users (Settings → ניהול משתמשים) — nothing to add/remove
      // here manually. This screen just sets who gets auto-shared into your new lists.
      const [members,  setMembers]  = useState(null);

      useEffect(function() {
        fns.httpsCallable("listTeamMembers")().then(function(res) {
          var others = (res.data.members || []).filter(function(m) { return m.uid !== user.uid; });
          db.ref("shareDefaults").once("value").then(function(snap) {
            var defaults = snap.val() || {};
            others.sort(function(a, b) { return (a.name || "").localeCompare(b.name || "", "he"); });
            setMembers(others.map(function(m) { return Object.assign({}, m, { alwaysShare: !!defaults[m.uid] }); }));
          });
        }, function() { setMembers([]); showToast("שגיאה בטעינת אנשי קשר"); });
      }, []);

      const toggleAlways = (uid) => {
        var next;
        setMembers(function(prev) {
          return prev.map(function(m) {
            if (m.uid !== uid) return m;
            next = !m.alwaysShare;
            return Object.assign({}, m, { alwaysShare: next });
          });
        });
        db.ref("shareDefaults/" + uid).set(next || null);
      };

      return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <div className="bg-blue-600 text-white px-4 pt-10 pb-4 flex-shrink-0">
            <div className="flex items-center gap-3" dir="ltr">
              <button onClick={onBack} className="flex items-center gap-1 text-white font-semibold text-sm bg-white/20 px-3 py-1.5 rounded-full flex-shrink-0">
                <span className="text-lg leading-none">‹</span><span>חזרה</span>
              </button>
              <h1 className="flex-1 text-lg font-bold text-right">אנשי קשר</h1>
            </div>
            <p className="text-white/60 text-xs mt-1 text-right">משתמשים שאתה משתף איתם בקביעות</p>
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {members === null ? (
              <div className="flex justify-center py-20"><Spinner large /></div>
            ) : members.length === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <div className="text-5xl mb-3">👥</div>
                <p className="font-medium">אין עדיין משתמשים נוספים</p>
                <p className="text-sm mt-1">הוסף אנשים תחת הגדרות ← ניהול משתמשים</p>
              </div>
            ) : (
              <div className="space-y-3">
                {members.map(function(m) {
                  return (
                    <div key={m.uid} className="bg-white rounded-2xl border border-gray-100 shadow-sm px-4 py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-gray-800">{m.name}</div>
                        <div className="text-xs text-gray-400 truncate">{m.email}</div>
                      </div>
                      <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                        <button onClick={function() { toggleAlways(m.uid); }}
                          className={"relative inline-flex h-6 w-11 items-center rounded-full transition-colors " + (m.alwaysShare ? "bg-blue-600" : "bg-gray-200")}>
                          <span className={"inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " + (m.alwaysShare ? "translate-x-6" : "translate-x-1")} />
                        </button>
                        <span className="text-xs text-gray-400">תמיד</span>
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-gray-400 text-center pt-2">אנשים עם "תמיד" יתווספו אוטומטית כשרשימה הופכת לשיתופית</p>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ── CATEGORIES SCREEN ─────────────────────────────────────────────────────────
    function guessEmoji(label) {
      var l = label;
      var map = [
        [["בשר","עוף","כבש","טלה","נקניק","המבורגר","שווארמה","קבב","סטייק"], "🥩"],
        [["דג","סלמון","טונה","מקרל","אנשובי","בקלה","דניס","לברק"], "🐟"],
        [["לחם","מאפה","בגט","פיתה","חלה","עוגה","עוגיה","קרואסון","סופגניה","בורקס","כיש"], "🍞"],
        [["ירק","פרי","עגבניה","מלפפון","חסה","גזר","בצל","תפוח","בננה","תפוז","ענב","אבוקדו","אפרסק","מנגו","לימון","תות","קיווי","רימון","אגס","שזיף"], "🥦"],
        [["חלב","גבינה","יוגורט","שמנת","חמאה","קוטג","לבנה","קשקבל","מוצרלה","בולגרית"], "🥛"],
        [["ביצ"], "🥚"],
        [["נייר","טואלט","מגבת","ניילון","שקית","מפית"], "🧻"],
        [["ניקוי","סבון","מרכך","אבקה","אקונומיקה","ברק","ג'אב","פיירי","דטרגנט"], "🧴"],
        [["שמן","חומץ","מלח","פלפל","תבל","פפריקה","כורכום","רוטב","חרדל","מיונז","קטשופ"], "🫙"],
        [["קמח","סוכר","שוקולד","ריבה","דבש","ממרח","גרנולה","דגני"], "🫙"],
        [["קפה","תה","שימור","קופסא","קופסת","שעועית","אורז","פסטה","קטניות","עדשים","חומוס"], "📦"],
        [["שתיה","מיץ","מים","סודה","בירה","יין","קולה","ספרייט","פאנטה","ענבים"], "🧃"],
        [["קרח","גלידה","קפוא","ארטיק","פרוז"], "🧊"],
        [["חטיף","ביסקויט","קרקר","פרינגלס","פצפוצים","נאגטס","פופקורן"], "🍿"],
        [["רחצה","שיניים","מברשת","שמפו","קרם","אפטרשייב","דאודורנט","היגיינה","אישי","סבוני","קצף"], "🛁"],
        [["חיות","כלב","חתול","פינוקים","מזון לחיות"], "🐾"],
        [["תינוק","חיתול","מחית","פורמולה","מוצץ"], "👶"],
        [["תרופה","ויטמין","כדור","אספירין","פארמ","בריאות"], "💊"],
        [["פרח","צמח","אדמה","זרע","עציץ"], "🌸"],
        [["כלי בית","סיר","מחבת","כוס","צלחת","קערה","ווק"], "🍳"],
      ];
      for (var i = 0; i < map.length; i++) {
        var kws = map[i][0];
        for (var j = 0; j < kws.length; j++) {
          if (l.indexOf(kws[j]) !== -1) return map[i][1];
        }
      }
      return "📦";
    }

    // Fills in a store profile's saved category order with any categories it
    // doesn't mention yet (new categories added after the profile was made),
    // appended in the app's default order.
    function resolveProfileOrder(categoryOrder, allCategories) {
      var labels = allCategories.map(function(c) { return c.label; });
      var order = (categoryOrder || []).filter(function(l) { return labels.indexOf(l) !== -1; });
      labels.forEach(function(l) { if (order.indexOf(l) === -1) order.push(l); });
      return order;
    }

    function CategoriesScreen({ user, onBack, showToast }) {
      const [categories,    setCategories]    = useState(null);
      const [editingId,     setEditingId]     = useState(null);
      const [editLabel,     setEditLabel]     = useState("");
      const [editEmoji,     setEditEmoji]     = useState("");
      const [newLabel,      setNewLabel]      = useState("");
      const [newEmoji,      setNewEmoji]      = useState("📦");
      const [profiles,      setProfiles]      = useState([]);
      const [editProfile,   setEditProfile]   = useState(null);
      const [addProfileName,setAddProfileName]= useState("");
      const [confirmDialog, setConfirmDialog] = useState(null);

      useEffect(function() {
        db.ref("globalCategories").once("value").then(function(snap) {
          if (snap.exists()) {
            var arr = [];
            snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
            arr.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
            setCategories(arr);
          } else {
            setCategories([]);
          }
        });
        db.ref("globalProfiles").once("value").then(function(snap) {
          var arr = [];
          snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
          setProfiles(arr);
        });
      }, []);

      const addCategory = () => {
        if (!newLabel.trim()) return;
        const id = "cat_" + Date.now();
        const cat = { id: id, label: newLabel.trim(), emoji: newEmoji.trim() || "📦", order: categories ? categories.length : 0 };
        setCategories(function(prev) { return prev ? prev.concat([cat]) : [cat]; });
        setNewLabel(""); setNewEmoji("📦");
        db.ref("globalCategories" + "/" + id).set({ label: cat.label, emoji: cat.emoji, order: cat.order })
          .then(function() { showToast("קטגוריה נוספה!"); },
                function(err) { showToast("שגיאה: " + (err && err.message || "?")); setCategories(function(prev) { return prev ? prev.filter(function(c) { return c.id !== id; }) : []; }); });
      };

      const saveEdit = (cat) => {
        if (!editLabel.trim()) return;
        const lbl = editLabel.trim(), emoji = editEmoji.trim() || "📦";
        setCategories(function(prev) { return prev ? prev.map(function(c) { return c.id === cat.id ? Object.assign({}, c, { label: lbl, emoji: emoji }) : c; }) : []; });
        setEditingId(null);
        db.ref("globalCategories" + "/" + cat.id).update({ label: lbl, emoji: emoji })
          .then(function() { showToast("קטגוריה עודכנה!"); },
                function(err) { showToast("שגיאה: " + (err && err.message || "?")); });
      };

      const deleteCategory = (cat) => {
        setConfirmDialog({
          message: 'למחוק את הקטגוריה "' + cat.label + '"?',
          onConfirm: function() {
            setCategories(function(prev) { return prev ? prev.filter(function(c) { return c.id !== cat.id; }) : []; });
            db.ref("globalCategories/" + cat.id).remove()
              .then(function() { showToast("קטגוריה נמחקה"); },
                    function(err) { showToast("שגיאה: " + (err && err.message || "?")); });
          }
        });
      };

      const moveUp = (idx) => {
        if (idx === 0 || !categories) return;
        const arr = categories.slice();
        const tmp = arr[idx]; arr[idx] = arr[idx - 1]; arr[idx - 1] = tmp;
        arr.forEach(function(c, i) { c.order = i; });
        setCategories(arr.slice());
        const updates = {};
        updates["globalCategories" + "/" + arr[idx].id + "/order"] = idx;
        updates["globalCategories" + "/" + arr[idx - 1].id + "/order"] = idx - 1;
        db.ref().update(updates);
      };

      const moveDown = (idx) => {
        if (!categories || idx >= categories.length - 1) return;
        const arr = categories.slice();
        const tmp = arr[idx]; arr[idx] = arr[idx + 1]; arr[idx + 1] = tmp;
        arr.forEach(function(c, i) { c.order = i; });
        setCategories(arr.slice());
        const updates = {};
        updates["globalCategories" + "/" + arr[idx].id + "/order"] = idx;
        updates["globalCategories" + "/" + arr[idx + 1].id + "/order"] = idx + 1;
        db.ref().update(updates);
      };

      const addProfile = () => {
        if (!addProfileName.trim() || !categories) return;
        var order = categories.map(function(c) { return c.label; });
        var newProfile = { name: addProfileName.trim(), categoryOrder: order };
        db.ref("globalProfiles").push(newProfile).then(function(ref) {
          var p = Object.assign({ id: ref.key }, newProfile);
          setProfiles(function(prev) { return prev.concat(p); });
          setAddProfileName("");
          showToast("פרופיל נוסף!");
        }, function() { showToast("שגיאה"); });
      };

      const promptDeleteProfile = (p) => {
        setConfirmDialog({
          message: "למחוק את הפרופיל " + p.name + "?",
          onConfirm: function() {
            setProfiles(function(prev) { return prev.filter(function(x) { return x.id !== p.id; }); });
            db.ref("globalProfiles/" + p.id).remove();
            showToast("פרופיל נמחק");
            if (localStorage.getItem("buli_profile") === p.id) localStorage.removeItem("buli_profile");
          }
        });
      };

      const moveProfileCatUp = (idx) => {
        if (!editProfile || idx === 0) return;
        var order = resolveProfileOrder(editProfile.categoryOrder, categories || []);
        var tmp = order[idx]; order[idx] = order[idx - 1]; order[idx - 1] = tmp;
        var updated = Object.assign({}, editProfile, { categoryOrder: order });
        setEditProfile(updated);
        setProfiles(function(prev) { return prev.map(function(p) { return p.id === updated.id ? updated : p; }); });
        db.ref("globalProfiles" + "/" + updated.id + "/categoryOrder").set(order);
      };

      const moveProfileCatDown = (idx) => {
        if (!editProfile) return;
        var order = resolveProfileOrder(editProfile.categoryOrder, categories || []);
        if (idx >= order.length - 1) return;
        var tmp = order[idx]; order[idx] = order[idx + 1]; order[idx + 1] = tmp;
        var updated = Object.assign({}, editProfile, { categoryOrder: order });
        setEditProfile(updated);
        setProfiles(function(prev) { return prev.map(function(p) { return p.id === updated.id ? updated : p; }); });
        db.ref("globalProfiles" + "/" + updated.id + "/categoryOrder").set(order);
      };

      if (categories === null) return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <Header onBack={onBack} title="הגדרות" />
          <div className="flex-1 flex items-center justify-center">
            <Spinner large />
          </div>
        </div>
      );

      const profileCatOrder = editProfile ? resolveProfileOrder(editProfile.categoryOrder, categories) : [];

      return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <Header onBack={onBack} title="הגדרות" />
          <div className="flex-1 overflow-y-auto p-4 pb-8">

            {/* — Categories section — */}
            <h2 className="font-bold text-gray-600 text-sm mb-2 text-right">קטגוריות</h2>
            <p className="text-xs text-gray-400 mb-3 text-right">סדר ברירת המחדל של הקטגוריות ברשימה</p>
            {categories.length === 0 && (
              <p className="text-center text-gray-400 py-4 text-sm">עדיין אין קטגוריות</p>
            )}
            <div className="space-y-2 mb-4">
              {categories.map((cat, idx) => (
                <div key={cat.id} className="bg-white rounded-xl border border-gray-100 px-3 py-2.5">
                  {editingId === cat.id ? (
                    <div className="flex gap-2 items-center">
                      <input value={editEmoji} onChange={e => setEditEmoji(e.target.value)} maxLength={2}
                        className="w-12 border border-gray-200 rounded-lg text-center text-xl py-1.5 focus:outline-none focus:border-blue-400" />
                      <input value={editLabel} onChange={e => setEditLabel(e.target.value)} autoFocus
                        onKeyDown={e => e.key === "Enter" && saveEdit(cat)}
                        className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-right text-sm focus:outline-none focus:border-blue-400" />
                      <button onClick={() => saveEdit(cat)} className="text-green-500 text-xl font-bold w-8 text-center">✓</button>
                      <button onClick={() => setEditingId(null)} className="text-gray-400 text-xl w-8 text-center">✕</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2" dir="ltr">
                      <div className="flex gap-0.5">
                        <button onClick={() => moveUp(idx)} disabled={idx === 0}
                          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-20 text-sm">↑</button>
                        <button onClick={() => moveDown(idx)} disabled={idx === categories.length - 1}
                          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-20 text-sm">↓</button>
                      </div>
                      <span className="text-xl">{cat.emoji}</span>
                      <span className="flex-1 font-medium text-gray-800 text-sm text-right">{cat.label}</span>
                      <button onClick={() => { setEditingId(cat.id); setEditLabel(cat.label); setEditEmoji(cat.emoji); }}
                        className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-500 text-sm">✏️</button>
                      <button onClick={() => deleteCategory(cat)}
                        className="w-7 h-7 flex items-center justify-center text-gray-300 hover:text-red-500 text-base">🗑️</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="bg-white rounded-2xl border border-gray-200 p-4 mb-8">
              <h3 className="font-semibold text-gray-700 mb-3 text-sm">קטגוריה חדשה</h3>
              <div className="flex gap-2 mb-3">
                <input value={newEmoji} onChange={e => setNewEmoji(e.target.value)} maxLength={2}
                  className="w-14 border border-gray-200 rounded-xl px-2 py-3 text-center text-xl focus:outline-none focus:border-blue-400" />
                <input value={newLabel} onChange={e => { setNewLabel(e.target.value); setNewEmoji(guessEmoji(e.target.value)); }}
                  placeholder="שם הקטגוריה..." onKeyDown={e => e.key === "Enter" && addCategory()}
                  className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400" />
              </div>
              <button onClick={addCategory} disabled={!newLabel.trim()}
                className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium disabled:opacity-40">
                + הוסף קטגוריה
              </button>
            </div>

            {/* — Store profiles section — */}
            <h2 className="font-bold text-gray-600 text-sm mb-1 text-right">פרופילי חנויות 🏪</h2>
            <p className="text-xs text-gray-400 mb-3 text-right">סדר קטגוריות שונה לכל רשת סופרמרקט</p>
            <div className="space-y-2 mb-4">
              {profiles.length === 0 && (
                <p className="text-center text-gray-400 py-3 text-sm">אין פרופילים — הוסף חנות למטה</p>
              )}
              {profiles.map(function(p) {
                return (
                  <div key={p.id} className="bg-white rounded-xl border border-gray-100 px-3 py-2.5 flex items-center gap-2" dir="ltr">
                    <button onClick={function() { setEditProfile(p); }}
                      className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-500 text-sm">✏️</button>
                    <span className="flex-1 font-medium text-gray-800 text-sm text-right">{p.name}</span>
                    <button onClick={function() { promptDeleteProfile(p); }}
                      className="w-7 h-7 flex items-center justify-center text-gray-300 hover:text-red-500 text-base">🗑️</button>
                  </div>
                );
              })}
            </div>
            <div className="bg-white rounded-2xl border border-gray-200 p-4">
              <h3 className="font-semibold text-gray-700 mb-3 text-sm">פרופיל חנות חדש</h3>
              <input value={addProfileName} onChange={e => setAddProfileName(e.target.value)}
                placeholder="שם החנות (למשל: רמי לוי)" onKeyDown={e => e.key === "Enter" && addProfile()}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400 mb-3" />
              <button onClick={addProfile} disabled={!addProfileName.trim() || !categories || !categories.length}
                className="w-full bg-blue-600 text-white py-3 rounded-xl font-medium disabled:opacity-40">
                + הוסף חנות
              </button>
            </div>
          </div>

          {/* Profile category order editor */}
          {editProfile && (
            <Modal onClose={function() { setEditProfile(null); }}>
              <h3 className="text-lg font-bold text-center mb-1">{editProfile.name}</h3>
              <p className="text-xs text-gray-400 text-center mb-4">גרור או לחץ חצים לשינוי הסדר</p>
              <div className="space-y-2 max-h-64 overflow-y-auto mb-4">
                {profileCatOrder.map(function(label, idx) {
                  var cat = (categories || []).find(function(c) { return c.label === label; });
                  return (
                    <div key={label} className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2" dir="ltr">
                      <div className="flex gap-0.5">
                        <button onClick={function() { moveProfileCatUp(idx); }} disabled={idx === 0}
                          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-20 text-sm">↑</button>
                        <button onClick={function() { moveProfileCatDown(idx); }} disabled={idx === profileCatOrder.length - 1}
                          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-blue-600 disabled:opacity-20 text-sm">↓</button>
                      </div>
                      <span className="text-lg">{cat ? cat.emoji : "📦"}</span>
                      <span className="flex-1 text-sm font-medium text-gray-800 text-right">{label}</span>
                      <span className="text-xs text-gray-300">{idx + 1}</span>
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-gray-400 text-center mb-3">השינויים נשמרים אוטומטית</p>
              <button onClick={function() { setEditProfile(null); }} className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold">סיום</button>
            </Modal>
          )}

          {confirmDialog && <ConfirmDialog message={confirmDialog.message} onConfirm={confirmDialog.onConfirm} onClose={function() { setConfirmDialog(null); }} />}
        </div>
      );
    }

    // ── LIST SCREEN ───────────────────────────────────────────────────────────────
    function ListScreen({ user, listId, onBack, onAdd, showToast }) {
      const [categories, setCategories] = useState([]);
      const [list,       setList]       = useState(null);
      const [items,      setItems]      = useState([]);
      const [loading,    setLoading]    = useState(true);
      const [loadError,  setLoadError]  = useState(null);
      const [profiles,         setProfiles]         = useState([]);
      // In pricing mode, category order is driven automatically by which
      // shop is selected (see the effect below). Without pricing, there's no
      // shop to derive it from, so it stays manually picked, same as before.
      const [sortBy,     setSortBy]     = useState("category");
      const [showProfilePicker,setShowProfilePicker]= useState(false);
      const [activeProfile,    setActiveProfile]    = useState(function() { return localStorage.getItem("buli_profile") || "default"; });
      const [editItem,      setEditItem]      = useState(null);
      const [taskEdit,      setTaskEdit]      = useState(null);
      const [noteEdit,      setNoteEdit]      = useState(null);
      const [confirmDialog, setConfirmDialog] = useState(null);
      const [showShare,        setShowShare]        = useState(false);
      const [contacts,         setContacts]         = useState([]);
      const [selectedContacts, setSelectedContacts] = useState([]);
      const [shareEmail,       setShareEmail]       = useState("");
      const [shareRole,        setShareRole]        = useState("edit");
      const [sharing,          setSharing]          = useState(false);
      const [filterStatus, setFilterStatus] = useState(function() { return localStorage.getItem("buli_filter_status") || "all"; });
      const [filterPerson, setFilterPerson] = useState(function() { return localStorage.getItem("buli_filter_person") || "all"; });
      // "all" | "noBarcode" | a profile id — which vendor branch an item must
      // actually be sold at (or "noBarcode" for still-unmatched items).
      const [filterVendorProfile, setFilterVendorProfile] = useState(function() { return localStorage.getItem("buli_filter_vendor") || "all"; });
      useEffect(function() { localStorage.setItem("buli_filter_vendor", filterVendorProfile); }, [filterVendorProfile]);
      const [showFilters, setShowFilters] = useState(false);
      const [pricingEnabled, setPricingEnabled] = useState(false);
      // Survives ListScreen unmounting (leaving the list, adding items, etc.) —
      // without this, every re-entry into the same list re-fetched every
      // price from scratch even seconds after you'd just seen them, since
      // React resets component state on remount. Real vendor prices don't
      // change faster than once a day server-side anyway, so caching here
      // for the life of the tab loses nothing; "🔄 רענן מחירים" (force
      // refresh) always bypasses it and re-populates it with fresh data.
      const priceCacheEntry = priceCacheByList[listId];
      // { [profileId]: { [barcode]: price } } — server-resolved, cap-enforced
      // active vendor+branch profiles (see getBasketPrices' `profiles` field).
      const [activeProfiles, setActiveProfiles] = useState(function() { return (priceCacheEntry && priceCacheEntry.activeProfiles) || []; });
      const [priceMap,       setPriceMap]       = useState(function() { return (priceCacheEntry && priceCacheEntry.priceMap) || {}; });
      // { [itemName]: { vendors: [chainIds searched], list: [candidates] } }
      const [candidatesByName, setCandidatesByName] = useState({});
      const [pickerItem,      setPickerItem]      = useState(null);
      const [pickerQuery,     setPickerQuery]      = useState("");
      const [pickerSearching, setPickerSearching]  = useState(false);
      const [resolveBusy,     setResolveBusy]     = useState(false);
      const itemsListenerRef = useRef(null); // { ref, cb } for the live items subscription below

      const loadList = function() {
        setLoadError(null);
        var done = 0;
        var settled = false;
        // Same class of bug as HomeScreen's prewarm: RTDB's once('value') has
        // no built-in timeout, so a stalled connection left this stuck on the
        // spinner indefinitely with no error and no retry. This mirrors that
        // fix — a 12s cap surfaces a retryable error instead.
        var timer = setTimeout(function() {
          if (settled) return;
          settled = true;
          setLoadError("תם הזמן הקצוב לטעינה");
        }, 12000);
        function tick() {
          if (settled) return;
          if (++done >= 3) { settled = true; clearTimeout(timer); setLoading(false); }
        }

        db.ref("globalCategories").once("value").then(function(snap) {
          if (snap.exists()) {
            var arr = [];
            snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
            arr.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
            setCategories(arr);
          }
          tick();
        }, tick);

        db.ref("lists/" + listId).once("value").then(function(snap) {
          if (snap.exists()) setList(Object.assign({ id: snap.key }, snap.val()));
          tick();
        }, tick);

        // Live, not once — items change from other places while this list is
        // open (AddScreen pushing new items, another device, a family member
        // editing the shared list concurrently), and a one-time read had no
        // way to reflect any of that without leaving and re-entering the
        // list. Scoped to just the one list on screen, detached on unmount
        // and re-attached (via loadList itself being idempotent, see below)
        // on retry from the load-error screen.
        if (itemsListenerRef.current) {
          itemsListenerRef.current.ref.off("value", itemsListenerRef.current.cb);
          itemsListenerRef.current = null;
        }
        var itemsTicked = false;
        var itemsRef = db.ref("items/" + listId);
        function onItemsSnapshot(snap) {
          var arr = [];
          snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
          arr.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
          setItems(arr);
          if (!itemsTicked) { itemsTicked = true; tick(); }
        }
        itemsRef.on("value", onItemsSnapshot, tick);
        itemsListenerRef.current = { ref: itemsRef, cb: onItemsSnapshot };

        fns.httpsCallable("listTeamMembers")().then(function(res) {
          var others = (res.data.members || []).filter(function(m) { return m.uid !== user.uid; });
          db.ref("shareDefaults").once("value").then(function(dsnap) {
            var defaults = dsnap.val() || {};
            others.sort(function(a, b) { return (a.name || "").localeCompare(b.name || "", "he"); });
            setContacts(others.map(function(m) { return { id: m.uid, name: m.name, email: m.email, alwaysShare: !!defaults[m.uid] }; }));
          });
        }, function() { setContacts([]); });

        db.ref("globalProfiles").once("value").then(function(snap) {
          var arr = [];
          snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
          setProfiles(arr);
        });

        db.ref("users/" + user.uid + "/pricingEnabled").once("value").then(function(snap) {
          setPricingEnabled(!!snap.val());
        });
      };
      useEffect(function() {
        loadList();
        return function() {
          if (itemsListenerRef.current) {
            itemsListenerRef.current.ref.off("value", itemsListenerRef.current.cb);
            itemsListenerRef.current = null;
          }
        };
      }, []);

      // Picking a shop to filter by also switches the category order to
      // whichever named profile matches that shop (so aisle order lines up
      // with where you're actually shopping) — falls back to default when
      // no shop is selected or no matching profile exists.
      useEffect(function() {
        if (!pricingEnabled) return; // manual picker (below) handles it instead
        if (filterVendorProfile === "all" || filterVendorProfile === "noBarcode") {
          setActiveProfile("default");
          return;
        }
        var prof = activeProfiles.find(function(p) { return p.id === filterVendorProfile; });
        var shopLabel = prof ? profileLabel(prof, activeProfiles) : null;
        var match = shopLabel ? profiles.find(function(p) { return p.name === shopLabel; }) : null;
        setActiveProfile(match ? match.id : "default");
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pricingEnabled, filterVendorProfile, activeProfiles, profiles]);

      // ─── Price comparison (any number of active vendor+branch profiles) —
      // no AI, plain lookups. item.barcodes is keyed by vendor CHAIN (a GTIN
      // doesn't change by branch); priceMap is keyed by PROFILE id (price
      // does change by branch). ───────────────────────────────────────────
      function collectBarcodesByVendor(itemList) {
        var out = {};
        itemList.forEach(function(i) {
          VENDOR_IDS.forEach(function(v) {
            var bc = itemVendorBarcode(i, v);
            if (!bc) return;
            if (!out[v]) out[v] = [];
            if (out[v].indexOf(bc) === -1) out[v].push(bc);
          });
        });
        return out;
      }
      // Same as collectBarcodesByVendor, but skips any (barcode, active
      // profile) pair the cache already has a price for — so reopening a
      // list only ever fetches what's actually new (an added item, a newly
      // activated shop), not everything again. Falls back to fetching
      // everything when we don't yet know which profiles are active (first
      // load ever, nothing cached) since there's nothing to compare against.
      function missingBarcodesByVendor(itemList, knownProfiles, knownPriceMap) {
        if (!knownProfiles || knownProfiles.length === 0) return collectBarcodesByVendor(itemList);
        var out = {};
        itemList.forEach(function(item) {
          VENDOR_IDS.forEach(function(v) {
            var bc = itemVendorBarcode(item, v);
            if (!bc) return;
            var relevant = knownProfiles.filter(function(p) { return p.vendor === v; });
            if (relevant.length === 0) return;
            var allKnown = relevant.every(function(p) { return knownPriceMap[p.id] && (bc in knownPriceMap[p.id]); });
            if (allKnown) return;
            if (!out[v]) out[v] = [];
            if (out[v].indexOf(bc) === -1) out[v].push(bc);
          });
        });
        return out;
      }
      const applyItemMatch = (item, vendorBarcodes, matchedName) => {
        var nextBarcodes = Object.assign({}, item.barcodes, vendorBarcodes);
        var updates = { barcodes: nextBarcodes };
        if (matchedName && matchedName !== item.name) {
          updates.originalName = item.originalName || item.name;
          updates.name = matchedName;
        }
        setItems(function(prev) { return prev.map(function(i) { return i.id === item.id ? Object.assign({}, i, updates) : i; }); });
        db.ref("items/" + listId + "/" + item.id).update(updates);
      };
      const fetchPrices = (barcodesByVendor, force) => {
        var hasAny = Object.keys(barcodesByVendor || {}).some(function(v) { return barcodesByVendor[v] && barcodesByVendor[v].length > 0; });
        if (!hasAny) return Promise.resolve();
        return fns.httpsCallable("getBasketPrices")({ barcodesByVendor: barcodesByVendor, force: !!force }).then(function(res) {
          var byProfile = res.data.prices || {};
          var nextProfiles = res.data.profiles || activeProfiles;
          setPriceMap(function(prev) {
            var next = Object.assign({}, prev);
            Object.keys(byProfile).forEach(function(pid) { next[pid] = Object.assign({}, next[pid], byProfile[pid]); });
            priceCacheByList[listId] = { priceMap: next, activeProfiles: nextProfiles };
            return next;
          });
          if (res.data.profiles) setActiveProfiles(res.data.profiles);
          var now = Date.now();
          setList(function(prev) { return prev ? Object.assign({}, prev, { pricesRefreshedAt: now }) : prev; });
          db.ref("lists/" + listId + "/pricesRefreshedAt").set(now);
        }).catch(function() {});
      };

      // getBasketPrices is what actually returns `profiles` (the server's
      // capped, validated view of this user's active vendor branches) — but
      // fetchPrices only ever calls it when there's a barcode to price. On a
      // list where nothing has matched a vendor's catalog yet (e.g. brand
      // new, or item names that just don't match), that call never fires, so
      // activeProfiles silently stays [] and the table shows "no active
      // branches" even though the user has real active profiles configured.
      // This bootstraps it directly, once, independent of pricing.
      useEffect(function() {
        if (!pricingEnabled || activeProfiles.length > 0) return;
        fns.httpsCallable("getBasketPrices")({ barcodesByVendor: {}, force: false }).then(function(res) {
          if (res.data.profiles && res.data.profiles.length > 0) {
            setActiveProfiles(res.data.profiles);
            priceCacheByList[listId] = Object.assign({}, priceCacheByList[listId], { activeProfiles: res.data.profiles });
          }
        }).catch(function() {});
      }, [pricingEnabled]);

      const [pricesRefreshing, setPricesRefreshing] = useState(false);
      const [pricesLoading, setPricesLoading] = useState(false);
      const [viewMode, setViewMode] = useState(function() { return localStorage.getItem("buli_view_mode") || "list"; }); // "list" | "table" — table is pricing-only
      useEffect(function() { localStorage.setItem("buli_view_mode", viewMode); }, [viewMode]);
      const refreshAllPrices = () => {
        var barcodesByVendor = collectBarcodesByVendor(items.filter(itemHasAnyBarcode));
        if (Object.keys(barcodesByVendor).length === 0) { showToast("אין פריטים עם ברקוד לרענון"); return; }
        setPricesRefreshing(true);
        fetchPrices(barcodesByVendor, true).then(function() {
          setPricesRefreshing(false);
          showToast("המחירים עודכנו");
        });
      };

      // Only chains among the user's currently active profiles count as
      // "relevant" for missing-vendor checks — a saved-but-inactive (or
      // never-added) chain must never make an item look permanently unmatched.
      var activeVendorIds = activeProfiles.reduce(function(acc, p) { if (acc.indexOf(p.vendor) === -1) acc.push(p.vendor); return acc; }, []);

      // Renaming an item (e.g. via EditItemModal) doesn't change items.length,
      // so it wouldn't otherwise re-trigger a re-resolve for a still-unmatched
      // item — this signature changes whenever any unresolved item's name does.
      var unresolvedSignature = items.filter(function(i) { return itemMissingVendors(i, activeVendorIds).length > 0; })
        .map(function(i) { return i.id + ":" + (i.name || ""); }).join("|");

      useEffect(function() {
        if (!pricingEnabled || items.length === 0) return;
        var barcoded = items.filter(itemHasAnyBarcode);
        if (barcoded.length > 0) {
          var missing = missingBarcodesByVendor(barcoded, activeProfiles, priceMap);
          var hasMissing = Object.keys(missing).some(function(v) { return missing[v] && missing[v].length > 0; });
          if (hasMissing) {
            setPricesLoading(true);
            fetchPrices(missing).then(function() { setPricesLoading(false); });
          }
        }

        var unresolved = items.filter(function(i) { return itemMissingVendors(i, activeVendorIds).length > 0 && i.name && i.name.trim(); });
        if (unresolved.length === 0) return;
        fns.httpsCallable("resolveItemBarcodes")({ items: unresolved.map(function(i) { return i.name; }) }).then(function(res) {
          var results = res.data.results || {};
          var newlyResolved = [];
          var newCandidates = {};
          var resolvedNames = [];
          unresolved.forEach(function(item) {
            var r = results[item.name];
            if (!r) return;
            var hadNone = !itemHasAnyBarcode(item);
            if (r.barcodes && Object.keys(r.barcodes).length > 0) {
              var vendorBarcodes = {};
              var firstMatchedName = null;
              Object.keys(r.barcodes).forEach(function(v) {
                vendorBarcodes[v] = r.barcodes[v].barcode;
                if (!firstMatchedName) firstMatchedName = r.barcodes[v].name;
              });
              applyItemMatch(item, vendorBarcodes, hadNone ? firstMatchedName : null);
              newlyResolved.push(Object.assign({}, item, { barcodes: Object.assign({}, item.barcodes, vendorBarcodes) }));
            }
            if (r.missingVendors && r.missingVendors.length > 0 && r.candidates) {
              // Store even when the candidate list is empty — that means
              // "searched, found nothing" (show a manual-search prompt),
              // distinct from no entry at all, which means "not searched yet".
              newCandidates[item.name] = { vendors: r.missingVendors, list: r.candidates };
            } else if (r.missingVendors && r.missingVendors.length === 0) {
              resolvedNames.push(item.name);
            }
          });
          if (newlyResolved.length > 0) fetchPrices(collectBarcodesByVendor(newlyResolved));
          if (resolvedNames.length > 0 || Object.keys(newCandidates).length > 0) {
            setCandidatesByName(function(prev) {
              var next = Object.assign({}, prev, newCandidates);
              resolvedNames.forEach(function(n) { delete next[n]; });
              return next;
            });
          }
        }).catch(function() {});
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pricingEnabled, items.length, unresolvedSignature]);

      useEffect(function() {
        if (pickerItem) setPickerQuery(pickerItem.name);
      }, [pickerItem]);

      if (loadError) return (
        <div className="bg-gray-50 flex flex-col items-center justify-center gap-3 px-6" style={{height:"100dvh"}}>
          <span className="text-4xl">⚠️</span>
          <p className="text-sm text-gray-500 text-center">לא הצלחנו לטעון את הרשימה.<br/>בדקו את החיבור לאינטרנט ונסו שוב.</p>
          <button onClick={loadList} className="bg-blue-600 text-white px-5 py-2 rounded-full text-sm font-medium">נסה שוב</button>
        </div>
      );
      if (loading || !list) return (
        <div className="bg-gray-50 flex flex-col items-center justify-center" style={{height:"100dvh"}}>
          <CartLoader />
        </div>
      );

      const isOwner    = list.ownerId === user.uid;
      const role       = isOwner ? "edit" : ((list.sharedWith && list.sharedWith[user.uid]) || "view");
      const canEditAll  = isOwner || role === "edit";
      const canAddItems = canEditAll || role === "own";
      const canEditItem = function(item) {
        if (canEditAll) return true;
        if (role === "own") return !!(item && item.addedBy === user.uid);
        return false;
      };

      const toggle = (item) => {
        if (!canEditItem(item)) return;
        const newDone = !item.done;
        const now = Date.now();
        setItems(function(prev) { return prev.map(function(i) { return i.id === item.id ? Object.assign({}, i, { done: newDone, completedAt: newDone ? now : null }) : i; }); });
        db.ref("items/" + listId + "/" + item.id).update({ done: newDone, completedAt: newDone ? now : null });
      };

      const remove = (id) => {
        var item = items.find(function(i) { return i.id === id; });
        if (!canEditItem(item)) return;
        setConfirmDialog({
          message: "למחוק " + (item ? item.name : "") + "?",
          onConfirm: function() {
            setItems(function(prev) { return prev.filter(function(i) { return i.id !== id; }); });
            db.ref("items/" + listId + "/" + id).remove();
            showToast("פריט נמחק");
          }
        });
      };

      const clearDone = () => {
        const doneItems = items.filter(function(i) { return i.done; });
        if (!doneItems.length) return;
        setConfirmDialog({
          message: "למחוק " + doneItems.length + (list && list.type === "tasks" ? " מטלות שהושלמו?" : " פריטים שנסלו?"),
          confirmLabel: "מחק",
          onConfirm: function() {
            setItems(function(prev) { return prev.filter(function(i) { return !i.done; }); });
            const updates = {};
            doneItems.forEach(function(i) { updates["items/" + listId + "/" + i.id] = null; });
            db.ref().update(updates);
            showToast("נוקה!");
          }
        });
      };

      const saveEdit = (updated) => {
        setItems(function(prev) { return prev.map(function(i) { return i.id === updated.id ? Object.assign({}, i, updated) : i; }); });
        setEditItem(null);
        db.ref("items/" + listId + "/" + updated.id).update({
          name: updated.name, quantity: updated.quantity !== "" && updated.quantity != null ? Number(updated.quantity) || 1 : null,
          unit: updated.unit, category: updated.category, note: updated.note || "",
          barcode: updated.barcode || null, barcodes: updated.barcodes || null, originalName: updated.originalName || null
        }).then(function() { showToast("פריט עודכן"); }, function(err) { showToast("שגיאה: " + (err && err.message || "?")); });
      };

      const saveTaskEdit = (updated) => {
        setItems(function(prev) { return prev.map(function(i) { return i.id === updated.id ? Object.assign({}, i, updated) : i; }); });
        setTaskEdit(null);
        db.ref("items/" + listId + "/" + updated.id).update({
          name: updated.name, note: updated.note || "", dueDate: updated.dueDate || ""
        }).then(function() { showToast("מטלה עודכנה"); }, function(err) { showToast("שגיאה: " + (err && err.message || "?")); });
      };

      const deleteTask = (id) => {
        setItems(function(prev) { return prev.filter(function(i) { return i.id !== id; }); });
        setTaskEdit(null);
        db.ref("items/" + listId + "/" + id).remove();
        showToast("מטלה נמחקה");
      };

      const saveNoteEdit = function(name, note) {
        if (!noteEdit || !name) return;
        var id = noteEdit.id;
        setItems(function(prev) { return prev.map(function(i) { return i.id === id ? Object.assign({}, i, { name: name, note: note }) : i; }); });
        setNoteEdit(null);
        db.ref("items/" + listId + "/" + id).update({ name: name, note: note });
      };

      const updateNote = (id, note) => {
        setItems(function(prev) { return prev.map(function(i) { return i.id === id ? Object.assign({}, i, { note: note }) : i; }); });
        db.ref("items/" + listId + "/" + id + "/note").set(note);
      };

      const pickPriceCandidate = (item, candidate) => {
        var entry = candidatesByName[item.name];
        var searchedVendors = (entry && entry.vendors) || Object.keys(candidate.prices || {});
        // Only confirm vendors this exact barcode was actually found for —
        // a butcher-counter item may match in one chain's catalog but not
        // the other (see [[feedback_buli_pricing_conditional]] context: no
        // shared GTIN exists for weighed goods), so the rest stay missing
        // and keep their own "match separately" affordance.
        var vendorsToConfirm = searchedVendors.filter(function(v) { return candidate.prices && candidate.prices[v] != null; });
        if (vendorsToConfirm.length === 0) return;
        setResolveBusy(true);
        fns.httpsCallable("confirmItemBarcode")({ name: item.name, barcode: candidate.barcode, matchedName: candidate.name, vendors: vendorsToConfirm }).then(function() {
          var vendorBarcodes = {};
          vendorsToConfirm.forEach(function(v) { vendorBarcodes[v] = candidate.barcode; });
          applyItemMatch(item, vendorBarcodes, candidate.name);
          // The candidate already carries confirmed vendors' prices from the
          // merged search — apply directly, no follow-up fetch needed.
          setPriceMap(function(prev) {
            var next = Object.assign({}, prev);
            activeProfiles.forEach(function(p) {
              if (vendorsToConfirm.indexOf(p.vendor) === -1) return;
              next[p.id] = Object.assign({}, next[p.id]);
              next[p.id][candidate.barcode] = candidate.prices[p.vendor];
            });
            return next;
          });
          var stillMissing = searchedVendors.filter(function(v) { return vendorsToConfirm.indexOf(v) === -1; });
          setCandidatesByName(function(prev) {
            var next = Object.assign({}, prev);
            if (stillMissing.length > 0) next[item.name] = Object.assign({}, entry, { vendors: stillMissing });
            else delete next[item.name];
            return next;
          });
          setPickerItem(null);
          setResolveBusy(false);
        }, function() { setResolveBusy(false); });
      };

      const handleResetMatch = (item) => {
        var revertedName = item.originalName || item.name;
        var cleared = { barcodes: null, barcode: null, originalName: null, name: revertedName };
        setItems(function(prev) { return prev.map(function(i) { return i.id === item.id ? Object.assign({}, i, cleared) : i; }); });
        db.ref("items/" + listId + "/" + item.id).update(cleared);
        setEditItem(null);
        fns.httpsCallable("resolveItemBarcodes")({ items: [revertedName], force: true }).then(function(res) {
          var r = (res.data.results || {})[revertedName];
          if (r && r.candidates && r.candidates.length > 0) {
            setCandidatesByName(function(prev) { var next = Object.assign({}, prev); next[revertedName] = { vendors: r.missingVendors, list: r.candidates }; return next; });
            setPickerItem(Object.assign({}, item, cleared));
          } else {
            showToast("לא נמצאו התאמות נוספות");
          }
        }, function() { showToast("שגיאה בחיפוש"); });
      };

      const refineSearch = () => {
        var q = pickerQuery.trim();
        if (!q || pickerSearching) return;
        setPickerSearching(true);
        fns.httpsCallable("resolveItemBarcodes")({ items: [q], force: true }).then(function(res) {
          var r = (res.data.results || {})[q];
          setCandidatesByName(function(prev) {
            var next = Object.assign({}, prev);
            next[pickerItem.name] = { vendors: (r && r.missingVendors) || VENDOR_IDS, list: (r && r.candidates) || [] };
            return next;
          });
          setPickerSearching(false);
        }, function() { showToast("שגיאה בחיפוש"); setPickerSearching(false); });
      };

      const shareWithContacts = () => {
        if (!selectedContacts.length && !shareEmail.trim()) return;
        setSharing(true);
        var total = selectedContacts.length + (shareEmail.trim() ? 1 : 0);
        var completed = 0;
        function done() {
          completed++;
          if (completed >= total) {
            setShowShare(false);
            setSelectedContacts([]);
            setShareEmail("");
            showToast("שותף!");
            setSharing(false);
          }
        }
        selectedContacts.forEach(function(uid) {
          // contacts[].id is already the target's uid (from listTeamMembers) — no lookup needed
          db.ref().update({ ["lists/" + listId + "/sharedWith/" + uid]: shareRole, ["listsByUser/" + uid + "/" + listId]: true }).then(done, done);
        });
        if (shareEmail.trim()) {
          db.ref("usersByEmail/" + encodeEmail(shareEmail.trim().toLowerCase())).once("value").then(function(snap) {
            if (!snap.exists()) { showToast("אימייל לא נמצא"); done(); return; }
            var uid = snap.val();
            db.ref().update({ ["lists/" + listId + "/sharedWith/" + uid]: shareRole, ["listsByUser/" + uid + "/" + listId]: true }).then(done, done);
          }, done);
        }
      };

      const openShare = () => {
        var preSelected = contacts.filter(function(c) { return c.alwaysShare; }).map(function(c) { return c.id; });
        setSelectedContacts(preSelected);
        setShareEmail("");
        setShowShare(true);
      };

      const isTasks = list.type === "tasks";
      const isNotes = list.type === "notes";
      const notesSorted = isNotes ? [...items].sort(function(a,b) { return (a.order||0)-(b.order||0); }) : [];
      const moveNoteItem = function(id, dir) {
        var idx = notesSorted.findIndex(function(i) { return i.id === id; });
        var swapIdx = idx + dir;
        if (idx < 0 || swapIdx < 0 || swapIdx >= notesSorted.length) return;
        var a = notesSorted[idx], b = notesSorted[swapIdx];
        var ao = a.order != null ? a.order : idx;
        var bo = b.order != null ? b.order : swapIdx;
        db.ref("items/" + listId + "/" + a.id + "/order").set(bo);
        db.ref("items/" + listId + "/" + b.id + "/order").set(ao);
        setItems(function(prev) {
          return prev.map(function(i) {
            if (i.id === a.id) return Object.assign({}, i, { order: bo });
            if (i.id === b.id) return Object.assign({}, i, { order: ao });
            return i;
          });
        });
      };
      const moveNoteUp   = function(id) { moveNoteItem(id, -1); };
      const moveNoteDown = function(id) { moveNoteItem(id,  1); };

      const applyStatusFilter = function(v) { setFilterStatus(v); localStorage.setItem("buli_filter_status", v); };
      const applyPersonFilter = function(v) { setFilterPerson(v); localStorage.setItem("buli_filter_person", v); };
      const clearAllFilters   = function() { applyStatusFilter("all"); applyPersonFilter("all"); setFilterVendorProfile("all"); };

      const filteredItems = items.filter(function(item) {
        if (filterPerson === "mine"   && item.addedBy !== user.uid) return false;
        if (filterPerson === "others" && item.addedBy === user.uid) return false;
        if (filterStatus === "done"    && !item.done) return false;
        if (filterStatus === "pending" &&  item.done) return false;
        if (filterVendorProfile === "noBarcode" && itemMissingVendors(item, activeVendorIds).length === 0) return false;
        if (filterVendorProfile !== "all" && filterVendorProfile !== "noBarcode") {
          var prof = activeProfiles.find(function(p) { return p.id === filterVendorProfile; });
          if (prof) {
            var bc = itemVendorBarcode(item, prof.vendor);
            var vp = priceMap[prof.id];
            var soldThere = !!(bc && vp && (bc in vp) && vp[bc] != null);
            if (!soldThere) return false;
          }
        }
        return true;
      });
      const notDone = filteredItems.filter(i => !i.done);
      const done    = filteredItems.filter(i =>  i.done);

      const editFn = (item) => isTasks ? setTaskEdit({...item}) : setEditItem({...item});

      // Same category grouping/order the list uses — shared so the table
      // view's row order matches what's actually shown in the list.
      const groupByCategory = (arr) => {
        var activeProf = activeProfile !== "default" ? profiles.find(function(p) { return p.id === activeProfile; }) : null;
        const catOrder = activeProf
          ? resolveProfileOrder(activeProf.categoryOrder, categories)
          : categories.map(c => c.label);
        const catMap = {};
        arr.forEach(i => {
          const c = i.category || "שונות";
          if (!catMap[c]) catMap[c] = { emoji: i.categoryEmoji || "🛍️", items: [] };
          catMap[c].items.push(i);
        });
        return [
          ...catOrder.filter(l => catMap[l]).map(l => ({ label: l, ...catMap[l] })),
          ...Object.entries(catMap).filter(([l]) => !catOrder.includes(l)).map(([l,v]) => ({ label: l, ...v }))
        ];
      };
      const orderByCategory = (arr) => groupByCategory(arr).flatMap(function(g) { return g.items; });

      const renderGroup = (arr) => {
        if (!isTasks && !pricingEnabled && sortBy === "name") {
          return (
            <div className="space-y-2">
              {[...arr].sort((a,b) => (a.name||"").localeCompare(b.name||"","he")).map(item =>
                <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={false} currentUserId={user.uid}
                  priceMap={priceMap} activeProfiles={activeProfiles} singleShopId={singleShopId} priceCandidates={candidatesByName[item.name]} onPickPrice={() => setPickerItem(item)} />
              )}
            </div>
          );
        }
        if (isTasks) {
          return (
            <div className="space-y-2">
              {arr.map(item =>
                <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={true} currentUserId={user.uid} />
              )}
            </div>
          );
        }
        const sortedGroups = groupByCategory(arr);
        return sortedGroups.map(group => (
          <div key={group.label} className="mb-5">
            <div className="text-xs font-semibold text-gray-400 mb-2 flex items-center gap-1 uppercase tracking-wide">
              <span>{group.emoji}</span><span>{group.label}</span>
            </div>
            <div className="space-y-2">
              {group.items.map(item => <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={false} currentUserId={user.uid}
                  priceMap={priceMap} activeProfiles={activeProfiles} singleShopId={singleShopId} priceCandidates={candidatesByName[item.name]} onPickPrice={() => setPickerItem(item)} />)}
            </div>
          </div>
        ));
      };

      const doneCount  = filteredItems.filter(i => i.done).length;
      const isFiltered = filterStatus !== "all" || filterPerson !== "all" || filterVendorProfile !== "all";
      const singleShopId = (pricingEnabled && !isTasks && filterVendorProfile !== "all" && filterVendorProfile !== "noBarcode") ? filterVendorProfile : null;
      const singleShopProfile = singleShopId ? activeProfiles.find(function(p) { return p.id === singleShopId; }) : null;

      return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <div className="bg-blue-600 text-white px-4 pt-10 pb-3 flex-shrink-0">
            <div className="flex items-center gap-3" dir="ltr">
              <button onClick={onBack} className="flex items-center gap-1 text-white font-semibold text-sm bg-white/20 px-3 py-1.5 rounded-full flex-shrink-0">
                <span className="text-lg leading-none">‹</span><span>חזרה</span>
              </button>
              <h1 className="flex-1 text-lg font-bold truncate text-right">{list.name}</h1>
              {isOwner && !list.isPrivate && !isNotes && (
                <button onClick={openShare} className="text-sm bg-white/20 px-3 py-1 rounded-full flex-shrink-0">שתף</button>
              )}
            </div>
            <div className="flex items-center justify-between mt-2" dir="ltr">
              {!isNotes && pricingEnabled && singleShopProfile ? (
                <span className="text-xs font-semibold bg-white/20 px-3 py-1 rounded-full whitespace-nowrap">
                  🏪 {profileLabel(singleShopProfile, activeProfiles)}
                </span>
              ) : !isNotes && !pricingEnabled ? (
                <div className="flex bg-white/15 rounded-full p-0.5">
                  <button onClick={function() { setSortBy("name"); }}
                    className={"text-xs px-3 py-1 rounded-full transition " + (sortBy==="name" ? "bg-white text-blue-600 font-semibold" : "text-white/70")}>שם</button>
                  <button onClick={function() {
                    setSortBy("category");
                    if (profiles.length > 0) setShowProfilePicker(true);
                  }} className={"text-xs px-3 py-1 rounded-full transition flex items-center gap-1 " + (sortBy==="category" ? "bg-white text-blue-600 font-semibold" : "text-white/70")}>
                    {sortBy === "category" && activeProfile !== "default"
                      ? ((profiles.find(function(p) { return p.id === activeProfile; }) || {}).name || "קטגוריה")
                      : "קטגוריה"}
                    {profiles.length > 0 && <span style={{fontSize:"9px"}}>▾</span>}
                  </button>
                </div>
              ) : <div />}
              <span className="text-white/50 text-xs flex items-center gap-2">
                {isNotes ? (notesSorted.filter(i=>i.done).length + "/" + notesSorted.length) : (isFiltered ? filteredItems.length + "/" + items.length : doneCount + "/" + items.length)}
                {doneCount > 0 && canEditAll && !isFiltered && (
                  <button onClick={clearDone} className="bg-white/20 text-white text-xs px-2.5 py-1 rounded-full font-medium">
                    🗑️ {isTasks ? "מחק הושלמו" : isNotes ? "מחק סיימו" : "מחק מסל"}
                  </button>
                )}
              </span>
            </div>
            {!isNotes && !(viewMode === "table" && pricingEnabled && !isTasks) && (
              <div className="mt-2" dir="ltr">
                <div className="flex items-center gap-1.5">
                  <div className="flex bg-white/15 rounded-full p-0.5 gap-0.5">
                    {[["all","הכל"],["pending","○ פתוח"],["done","✓ " + (isTasks ? "הושלם" : "בסל")]].map(function(entry) {
                      var v = entry[0], l = entry[1];
                      return (
                        <button key={v} onClick={function() { applyStatusFilter(v); }}
                          className={"text-xs px-2 py-1 rounded-full transition whitespace-nowrap " + (filterStatus===v ? "bg-white text-blue-600 font-semibold" : "text-white/70")}>
                          {l}
                        </button>
                      );
                    })}
                  </div>
                  {pricingEnabled ? (
                    <React.Fragment>
                      {!isTasks && (
                        <button onClick={function() { setFilterVendorProfile(function(p) { return p === "noBarcode" ? "all" : "noBarcode"; }); }}
                          className={"text-xs px-2 py-1 rounded-full transition whitespace-nowrap flex-shrink-0 " + (filterVendorProfile==="noBarcode" ? "bg-white text-orange-600 font-semibold" : "bg-white/15 text-white/70")}>
                          ⚠ ללא ברקוד
                        </button>
                      )}
                      <button onClick={function() { setShowFilters(function(p) { return !p; }); }}
                        className={"text-xs px-2.5 py-1 rounded-full transition whitespace-nowrap flex-shrink-0 flex items-center gap-1 " + (showFilters ? "bg-white text-blue-600 font-semibold" : "bg-white/15 text-white/70")}>
                        מסננים {(filterPerson !== "all" || singleShopId) && <span className="text-orange-300">●</span>}
                      </button>
                    </React.Fragment>
                  ) : (
                    <div className="flex bg-white/15 rounded-full p-0.5 gap-0.5">
                      {[["all","כולם"],["mine","שלי"],["others","אחרים"]].map(function(entry) {
                        var v = entry[0], l = entry[1];
                        return (
                          <button key={v} onClick={function() { applyPersonFilter(v); }}
                            className={"text-xs px-2.5 py-1 rounded-full transition " + (filterPerson===v ? "bg-white text-blue-600 font-semibold" : "text-white/70")}>
                            {l}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {isFiltered && (
                    <button onClick={clearAllFilters} className="text-white/60 hover:text-white text-xs flex-shrink-0" title="נקה פילטרים">✕</button>
                  )}
                </div>
                {pricingEnabled && showFilters && (
                  <div className="mt-2 bg-white/10 rounded-2xl p-2.5 space-y-2.5">
                    <div>
                      <div className="text-white/50 text-xs mb-1">מי הוסיף</div>
                      <div className="flex bg-white/15 rounded-full p-0.5 gap-0.5 w-fit">
                        {[["all","כולם"],["mine","שלי"],["others","אחרים"]].map(function(entry) {
                          var v = entry[0], l = entry[1];
                          return (
                            <button key={v} onClick={function() { applyPersonFilter(v); }}
                              className={"text-xs px-2.5 py-1 rounded-full transition " + (filterPerson===v ? "bg-white text-blue-600 font-semibold" : "text-white/70")}>
                              {l}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    {!isTasks && activeProfiles.length > 0 && (
                      <div>
                        <div className="text-white/50 text-xs mb-1">הצג פריטים לחנות</div>
                        <div className="flex flex-wrap gap-1">
                          {[{ id: "all", label: "הכל" }]
                            .concat(activeProfiles.map(function(p) { return { id: p.id, label: profileLabel(p, activeProfiles) }; }))
                            .map(function(opt) {
                              return (
                                <button key={opt.id} onClick={function() {
                                  setFilterVendorProfile(opt.id);
                                  if (opt.id !== "all") setShowFilters(false);
                                }} className={"text-xs px-2.5 py-1 rounded-full transition whitespace-nowrap " + (filterVendorProfile===opt.id ? "bg-white text-blue-600 font-semibold" : "bg-white/15 text-white/70")}>
                                  {opt.label}
                                </button>
                              );
                            })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {pricingEnabled && !isTasks && !isNotes && (
            <div className="flex items-center justify-between bg-white border-b border-gray-100 px-4 py-1.5 flex-shrink-0">
              <button onClick={refreshAllPrices} disabled={pricesRefreshing}
                className="text-xs text-blue-600 font-medium flex items-center gap-1 disabled:opacity-50">
                {pricesRefreshing ? <Spinner /> : "🔄"} רענן מחירים
              </button>
              <div className="flex items-center gap-2">
                {pricesLoading ? (
                  <span className="text-xs text-blue-500 flex items-center gap-1">
                    <span className="spinner w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full inline-block" />
                    טוען מחירים...
                  </span>
                ) : list.pricesRefreshedAt && (
                  <span className="text-xs text-gray-400">עודכן: {formatRefreshTime(list.pricesRefreshedAt)}</span>
                )}
                <button onClick={function() { setViewMode(viewMode === "table" ? "list" : "table"); }}
                  className="text-xs text-gray-500 font-medium border border-gray-200 rounded-full px-2 py-0.5">
                  {viewMode === "table" ? "📋 רשימה" : "🔢 טבלה"}
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 pb-28">
            {isNotes ? (
              notesSorted.length === 0 ? (
                <div className="text-center py-20 text-gray-400">
                  <div className="text-6xl mb-4">📝</div>
                  <p className="font-medium">אין מנות עדיין</p>
                  {canAddItems && <p className="text-sm mt-1">לחץ + להוסיף מנות</p>}
                </div>
              ) : (
                <div className="space-y-2">
                  {notesSorted.map(function(item, idx) {
                    return <NoteItemRow key={item.id} item={item} canEdit={canEditAll} onToggle={toggle} onDelete={remove} onEdit={function(it) { setNoteEdit(it); }} onSaveNote={updateNote} onMoveUp={function() { moveNoteUp(item.id); }} onMoveDown={function() { moveNoteDown(item.id); }} isFirst={idx===0} isLast={idx===notesSorted.length-1} />;
                  })}
                </div>
              )
            ) : items.length === 0 ? (
              <div className="text-center py-20 text-gray-400">
                <div className="text-6xl mb-4">🛍️</div>
                <p className="font-medium">הרשימה ריקה</p>
                {canAddItems && <p className="text-sm mt-1">{list.type === "tasks" ? "לחץ + להוסיף מטלות" : "לחץ + להוסיף פריטים"}</p>}
              </div>
            ) : filteredItems.length === 0 ? (
              <div className="text-center py-16 text-gray-400">
                <div className="text-5xl mb-3">🔍</div>
                <p className="font-medium">אין פריטים תואמים</p>
                <button onClick={clearAllFilters} className="mt-4 text-sm text-blue-500 bg-blue-50 px-5 py-2 rounded-full">נקה פילטרים</button>
              </div>
            ) : viewMode === "table" && pricingEnabled && !isTasks && !isNotes ? (
              <PriceComparisonTable items={orderByCategory(items.filter(function(i) { return !i.done; }))} activeProfiles={activeProfiles} priceMap={priceMap} />
            ) : (
              <>
                {renderGroup(notDone)}
                {done.length > 0 && (
                  <div className="mb-5 mt-2">
                    <div className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1">
                      <span>{isTasks ? "✅" : "🛒"}</span><span>{isTasks ? "הושלם" : "בסל"}</span>
                    </div>
                    <div className="space-y-2">
                      {done.map(item => <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={isTasks} currentUserId={user.uid} />)}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {canAddItems && !(viewMode === "table" && pricingEnabled && !isTasks && !isNotes) && (
            <button onClick={() => onAdd(list.type, list.name)} className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-8 py-4 rounded-2xl shadow-xl font-semibold text-base flex items-center gap-2">
              <span className="text-xl font-light">+</span> {isTasks ? "הוסף מטלה" : isNotes ? "הוסף מנות" : "הוסף פריטים"}
            </button>
          )}

          {editItem && <EditItemModal item={editItem} categories={categories} onChange={setEditItem} onSave={saveEdit} onResetMatch={handleResetMatch} pricingEnabled={pricingEnabled}
            priceCandidates={candidatesByName[editItem.name]} onPickPrice={() => setPickerItem(editItem)} onClose={() => setEditItem(null)} />}
          {noteEdit && <NoteEditModal item={noteEdit} onSave={saveNoteEdit} onClose={function() { setNoteEdit(null); }} />}
          {taskEdit && <TaskEditModal item={taskEdit} onChange={setTaskEdit} onSave={saveTaskEdit} onDelete={deleteTask} onClose={() => setTaskEdit(null)} />}
          {confirmDialog && <ConfirmDialog message={confirmDialog.message} confirmLabel={confirmDialog.confirmLabel} onConfirm={confirmDialog.onConfirm} onClose={function() { setConfirmDialog(null); }} />}

          {showProfilePicker && (
            <Modal onClose={function() { setShowProfilePicker(false); }}>
              <h3 className="text-lg font-bold text-center mb-4">סדר קטגוריות לפי חנות</h3>
              <div className="space-y-2">
                <button onClick={function() {
                  setActiveProfile("default");
                  localStorage.setItem("buli_profile", "default");
                  setShowProfilePicker(false);
                }} className={"w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-right transition " + (activeProfile === "default" ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200")}>
                  <div className={"w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center text-xs " + (activeProfile === "default" ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300")}>
                    {activeProfile === "default" ? "✓" : ""}
                  </div>
                  <span className="font-medium text-gray-800">ברירת מחדל</span>
                </button>
                {profiles.map(function(p) {
                  var sel = activeProfile === p.id;
                  return (
                    <button key={p.id} onClick={function() {
                      setActiveProfile(p.id);
                      localStorage.setItem("buli_profile", p.id);
                      setShowProfilePicker(false);
                    }} className={"w-full flex items-center gap-3 px-4 py-3 rounded-xl border text-right transition " + (sel ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200")}>
                      <div className={"w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center text-xs " + (sel ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300")}>
                        {sel ? "✓" : ""}
                      </div>
                      <span className="font-medium text-gray-800">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            </Modal>
          )}

          {pickerItem && (
            <Modal onClose={() => setPickerItem(null)}>
              <h3 className="text-lg font-bold text-center mb-1">בחר מוצר עבור "{pickerItem.name}"</h3>
              <p className="text-xs text-gray-400 text-center mb-3">בחר את ההתאמה המדויקת כדי לראות מחיר</p>
              <div className="flex gap-2 mb-3">
                <input value={pickerQuery} onChange={function(e) { setPickerQuery(e.target.value); }}
                  onKeyDown={function(e) { if (e.key === "Enter") refineSearch(); }}
                  placeholder="חדד את החיפוש, למשל: חלב 3%" dir="rtl"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-right focus:outline-none focus:border-blue-400" />
                <button onClick={refineSearch} disabled={!pickerQuery.trim() || pickerSearching}
                  className="bg-blue-600 text-white text-sm px-4 py-2 rounded-xl font-medium disabled:opacity-40 flex-shrink-0">
                  {pickerSearching ? <Spinner /> : "חפש"}
                </button>
              </div>
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {(function() {
                  var entry = candidatesByName[pickerItem.name];
                  var searchedVendors = (entry && entry.vendors) || [];
                  var list = (entry && entry.list) || [];
                  return (
                    <React.Fragment>
                      {list.map(function(c) {
                        var allFound = searchedVendors.length > 0 && searchedVendors.every(function(v) { return c.prices && c.prices[v] != null; });
                        return (
                          <button key={c.barcode} onClick={() => pickPriceCandidate(pickerItem, c)} disabled={resolveBusy}
                            className={"w-full text-right rounded-xl px-3 py-2.5 disabled:opacity-50 " + (allFound ? "bg-green-50 hover:bg-green-100 border border-green-200" : "bg-gray-50 hover:bg-gray-100")}>
                            <div className="text-sm font-medium text-gray-800">{c.name}</div>
                            <div className="text-xs text-gray-400 mb-1">{c.unit}</div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {searchedVendors.map(function(v) {
                                var meta = VENDOR_LIST.find(function(x) { return x.id === v; });
                                var price = c.prices ? c.prices[v] : null;
                                var others = searchedVendors.filter(function(o) { return o !== v; })
                                  .map(function(o) { return c.prices ? c.prices[o] : null; }).filter(function(x) { return x != null; });
                                return (
                                  <span key={v} className={"text-xs font-semibold px-1.5 py-0.5 rounded " + cheapestBadgeClass(price, others)}>
                                    {meta ? meta.label : v}: {price != null ? "₪" + Number(price).toFixed(2) : "לא נמכר כאן"}
                                  </span>
                                );
                              })}
                            </div>
                          </button>
                        );
                      })}
                      {list.length === 0 && !pickerSearching && (
                        <p className="text-center text-gray-400 text-sm py-4">לא נמצאו התאמות — נסה חיפוש מדויק יותר</p>
                      )}
                    </React.Fragment>
                  );
                })()}
              </div>
            </Modal>
          )}

          {showShare && (
            <Modal onClose={() => setShowShare(false)}>
              <h3 className="text-lg font-bold text-center mb-4">שתף רשימה</h3>
              {contacts.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs text-gray-400 mb-2 text-right">אנשי קשר</p>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {contacts.filter(function(c) { return c.id !== user.uid && (c.email || "").toLowerCase() !== (user.email || "").toLowerCase(); }).map(function(c) {
                      var sel = selectedContacts.indexOf(c.id) !== -1;
                      return (
                        <button key={c.id} onClick={function() {
                          setSelectedContacts(function(prev) {
                            return sel ? prev.filter(function(x) { return x !== c.id; }) : prev.concat(c.id);
                          });
                        }} className={"w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-right transition " + (sel ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200")}>
                          <div className={"w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center text-xs " + (sel ? "bg-blue-600 border-blue-600 text-white" : "border-gray-300")}>
                            {sel ? "✓" : ""}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 truncate">{c.name}</div>
                            <div className="text-xs text-gray-400 truncate">{c.email}</div>
                          </div>
                          {c.alwaysShare && <span className="text-xs text-blue-400 flex-shrink-0">תמיד</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <input value={shareEmail} onChange={e => setShareEmail(e.target.value)} type="email" placeholder={contacts.length > 0 ? "או הוסף אימייל" : "אימייל"}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400 mb-3" />
              <p className="text-xs text-gray-400 mb-2 text-right">הרשאות</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[["edit","✏️ מלאה"],["own","👤 שלי בלבד"],["view","👁️ צפייה"]].map(([v,l]) => (
                  <button key={v} onClick={() => setShareRole(v)}
                    className={`py-3 rounded-xl text-xs font-medium border transition ${shareRole===v?"bg-blue-600 text-white border-blue-600":"bg-white text-gray-600 border-gray-200"}`}>{l}</button>
                ))}
              </div>
              <button onClick={shareWithContacts} disabled={(!selectedContacts.length && !shareEmail.trim()) || sharing}
                className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold disabled:opacity-40 flex items-center justify-center gap-2">
                {sharing ? <Spinner /> : "שתף"}
              </button>
            </Modal>
          )}

        </div>
      );
    }

    function formatDueDate(dateStr) {
      if (!dateStr) return "";
      try { var p = dateStr.split("-"); return p[2] + "/" + p[1] + "/" + p[0]; } catch(e) { return dateStr; }
    }

    // Spreadsheet-style comparison: one row per item, one column per active
    // vendor+branch profile, so it's easy to see which basket is actually
    // cheaper overall and by how many items — the badge-per-row list view
    // shows a price, but not "how many of my items are even in this basket."
    // Sticky first column + horizontal scroll so it still works on mobile
    // with several columns.
    function PriceComparisonTable({ items, activeProfiles, priceMap }) {
      var notDoneItems = items.filter(function(i) { return !i.done; });
      var doneItems = items.filter(function(i) { return i.done; });
      var ordered = notDoneItems.concat(doneItems);

      var totals = {};
      activeProfiles.forEach(function(p) { totals[p.id] = { sum: 0, count: 0 }; });
      notDoneItems.forEach(function(item) {
        var qty = item.quantity || 1;
        itemProfilePrices(item, activeProfiles, priceMap).forEach(function(e) {
          if (e.price == null) return;
          totals[e.profile.id].sum += e.price * qty;
          totals[e.profile.id].count++;
        });
      });

      if (activeProfiles.length === 0) {
        return <p className="text-center text-gray-400 text-sm py-10">אין סניפים פעילים להשוואה</p>;
      }

      return (
        <div className="overflow-x-auto -mx-4 border border-gray-100 rounded-xl">
          <table className="min-w-full text-xs" style={{ borderCollapse: "separate", borderSpacing: 0 }}>
            <thead>
              <tr>
                <th className="sticky right-0 bg-gray-50 z-10 font-semibold text-gray-500 text-right px-3 py-2 border-b border-gray-200" style={{minWidth: 140}}>פריט</th>
                {activeProfiles.map(function(p) {
                  return <th key={p.id} className="font-semibold text-gray-500 text-center px-3 py-2 border-b border-gray-200 whitespace-nowrap">{profileLabel(p, activeProfiles)}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {ordered.map(function(item) {
                var priced = itemProfilePrices(item, activeProfiles, priceMap);
                var byId = {};
                priced.forEach(function(e) { byId[e.profile.id] = e.price; });
                return (
                  <tr key={item.id}>
                    <td className={"sticky right-0 bg-white z-10 px-3 py-2 border-b border-gray-100 text-right " + (item.done ? "line-through text-gray-400" : "text-gray-800")}>{item.name}</td>
                    {activeProfiles.map(function(p) {
                      var bc = itemVendorBarcode(item, p.vendor);
                      var vendorPrices = priceMap[p.id];
                      var fetched = !!(bc && vendorPrices && (bc in vendorPrices));
                      var price = fetched ? vendorPrices[bc] : null;
                      var others = priced.filter(function(e) { return e.profile.id !== p.id; }).map(function(e) { return e.price; });
                      var cellClass = !bc ? "text-gray-300" : !fetched ? "text-gray-300" : cheapestTextClass(price, others);
                      return (
                        <td key={p.id} className={"text-center px-3 py-2 border-b border-gray-100 " + cellClass}>
                          {!bc ? "—" : !fetched ? "…" : price != null ? "₪" + price.toFixed(2) : "אין"}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="sticky right-0 bg-gray-50 z-10 font-bold px-3 py-2 border-t-2 border-gray-300 text-right">סה"כ</td>
                {activeProfiles.map(function(p) {
                  var others = activeProfiles.filter(function(o) { return o.id !== p.id; }).map(function(o) { return totals[o.id].sum; });
                  return <td key={p.id} className={"font-bold text-center px-3 py-2 border-t-2 border-gray-300 " + cheapestTextClass(totals[p.id].sum, others)}>₪{totals[p.id].sum.toFixed(2)}</td>;
                })}
              </tr>
              <tr>
                <td className="sticky right-0 bg-gray-50 z-10 font-semibold text-gray-500 px-3 py-2 text-right">פריטים בסל</td>
                {activeProfiles.map(function(p) {
                  return <td key={p.id} className="font-semibold text-gray-500 text-center px-3 py-2">{totals[p.id].count}</td>;
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      );
    }

    function ItemRow({ item, canEdit, onToggle, onDelete, onEdit, onUpdateNote, isTasks, currentUserId, priceMap, activeProfiles, singleShopId, priceCandidates, onPickPrice }) {
      const [editingNote, setEditingNote] = useState(false);
      const [noteVal,     setNoteVal]     = useState(item.note || "");

      const openNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(true); };
      const saveNote = (e) => { e.stopPropagation(); onUpdateNote(item.id, noteVal.trim()); setEditingNote(false); };
      const cancelNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(false); };

      const qty = (!isTasks && (item.quantity > 1 || (item.unit && item.unit !== "יחידות"))) ? item.quantity + " " + (item.unit || "") : "";
      const dateStr = isTasks ? formatDueDate(item.dueDate) : "";
      const pricedEntries = (!isTasks && activeProfiles) ? itemProfilePrices(item, activeProfiles, priceMap || {}) : [];

      return (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className={`flex items-center gap-2 px-3 py-2.5 ${isTasks && canEdit ? "cursor-pointer active:bg-gray-50" : ""}`}
               onClick={isTasks && canEdit ? onEdit : undefined}>
            <span onClick={isTasks ? function(e){e.stopPropagation();} : undefined}>
              <Checkbox checked={!!item.done} onChange={() => onToggle(item)} />
            </span>
            <div className="flex-1 min-w-0">
              <span className={`font-medium text-sm ${item.done ? "line-through text-gray-400" : "text-gray-800"}`}>{item.name}</span>
              {currentUserId && item.addedBy && item.addedBy !== currentUserId && (
                <span style={{color: item.addedByColor || getUserColor(item.addedBy)}} className="block text-xs font-medium mt-0.5">
                  ● {item.addedByName ? item.addedByName.split(" ")[0] : ""}
                </span>
              )}
              {dateStr ? <div className="text-xs text-blue-400">{dateStr}</div> : null}
              {!editingNote && item.note ? (
                <div onClick={!isTasks && canEdit ? openNote : undefined}
                  className={`text-xs text-gray-400 mt-0.5 flex items-start gap-1 ${!isTasks && canEdit ? "cursor-pointer hover:text-gray-600" : ""}`}>
                  <span className="flex-shrink-0">💬</span><span className="break-words">{item.note}</span>
                </div>
              ) : !editingNote && !isTasks && canEdit ? (
                <button onClick={openNote} className="text-xs text-gray-300 hover:text-gray-500 mt-0.5 flex items-center gap-0.5">
                  <span>💬</span><span>הוסף הערה</span>
                </button>
              ) : null}
              {!isTasks && singleShopId ? (
                (function() {
                  var e = pricedEntries.find(function(x) { return x.profile.id === singleShopId; });
                  if (!e) return null;
                  return (
                    <div className="mt-1">
                      <span className="text-xs font-semibold text-gray-800">
                        {e.price != null ? "₪" + e.price.toFixed(2) : "לא נמכר כאן"}
                      </span>
                    </div>
                  );
                })()
              ) : !isTasks && pricedEntries.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-1">
                  {pricedEntries.map(function(e) {
                    var others = pricedEntries.filter(function(o) { return o.profile.id !== e.profile.id; }).map(function(o) { return o.price; });
                    return (
                      <span key={e.profile.id} className={"text-xs font-semibold px-1.5 py-0.5 rounded " + cheapestBadgeClass(e.price, others)}>
                        {profileLabel(e.profile, activeProfiles)}: {e.price != null ? "₪" + e.price.toFixed(2) : "לא נמכר כאן"}
                      </span>
                    );
                  })}
                </div>
              )}
              {/* Only surface the match action here for items with NO vendor
                  matched at all — once at least one is matched, seeing real
                  prices next to "still needs matching" reads as contradictory,
                  so the remaining vendor gets handled from the edit dialog. */}
              {!isTasks && !itemHasAnyBarcode(item) && priceCandidates && priceCandidates.list && priceCandidates.list.length > 0 && (
                <button onClick={function(e) { e.stopPropagation(); onPickPrice(); }}
                  className="text-xs text-blue-500 border border-blue-200 bg-blue-50 rounded-full px-2 py-0.5 mt-1">
                  💰 התאם פריט
                </button>
              )}
              {!isTasks && !itemHasAnyBarcode(item) && priceCandidates && priceCandidates.list && priceCandidates.list.length === 0 && (
                <button onClick={function(e) { e.stopPropagation(); onPickPrice(); }}
                  className="text-xs text-orange-600 border border-orange-200 bg-orange-50 rounded-full px-2 py-0.5 mt-1">
                  ⚠ לא נמצא ברקוד — חפש ידנית
                </button>
              )}
            </div>
            {!isTasks && qty ? (
              <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full flex-shrink-0 min-w-12 text-center">{qty}</span>
            ) : !isTasks ? <span className="w-12" /> : null}
            {!isTasks && canEdit && <button onClick={function(e){e.stopPropagation(); onEdit();}} className="text-gray-300 hover:text-blue-500 flex-shrink-0 text-sm px-0.5">✏️</button>}
            {!isTasks && canEdit && <button onClick={function(e){e.stopPropagation(); onDelete(item.id);}} className="text-gray-300 hover:text-red-400 flex-shrink-0 text-base leading-none px-0.5">🗑️</button>}
            {isTasks && canEdit && <span className="text-gray-300 text-base flex-shrink-0">›</span>}
          </div>
          {editingNote && (
            <div className="px-3 pb-3 pt-1 border-t border-gray-50">
              <div className="relative">
                <textarea value={noteVal} onChange={e => setNoteVal(e.target.value)} autoFocus rows={2}
                  placeholder="הוסף הערה..." dir="rtl"
                  className="w-full text-sm border border-blue-200 rounded-xl px-3 py-2 resize-none focus:outline-none focus:border-blue-400 text-right" />
                {noteVal ? (
                  <button onClick={() => setNoteVal("")} className="absolute left-2 top-2 text-gray-300 hover:text-gray-500 text-base leading-none">✕</button>
                ) : null}
              </div>
              <div className="flex gap-2 mt-1.5 items-center justify-start" dir="ltr">
                <button onClick={saveNote} className="text-xs bg-blue-600 text-white px-4 py-1.5 rounded-lg font-medium">שמור</button>
                <button onClick={cancelNote} className="text-xs text-gray-400 px-3 py-1.5 rounded-lg border border-gray-200">ביטול</button>
                <InlineMic onText={function(t) { setNoteVal(function(prev) { return prev ? prev + " " + t : t; }); }} />
              </div>
            </div>
          )}
        </div>
      );
    }

    function TaskEditModal({ item, onChange, onSave, onDelete, onClose }) {
      return (
        <Modal onClose={onClose}>
          <h3 className="text-lg font-bold text-center mb-4">עריכת מטלה</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">שם המטלה</label>
              <input value={item.name || ""} onChange={e => onChange({...item, name: e.target.value})}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">תיאור</label>
              <textarea value={item.note || ""} onChange={e => onChange({...item, note: e.target.value})} rows={3} placeholder="הערות, פרטים נוספים..."
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right resize-none focus:outline-none focus:border-blue-400" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">תאריך יעד</label>
              <input type="date" value={item.dueDate || ""} onChange={e => onChange({...item, dueDate: e.target.value})}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:border-blue-400" />
            </div>
          </div>
          <button onClick={() => onSave(item)} disabled={!item.name || !item.name.trim()}
            className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold mt-5 disabled:opacity-40">
            שמור שינויים
          </button>
          <button onClick={() => onDelete(item.id)}
            className="w-full mt-2 py-3 rounded-2xl text-red-500 font-medium border border-red-100 text-sm">
            🗑️ מחק מטלה
          </button>
        </Modal>
      );
    }

    function EditItemModal({ item, categories, onChange, onSave, onResetMatch, pricingEnabled, priceCandidates, onPickPrice, onClose }) {
      return (
        <Modal onClose={onClose}>
          <h3 className="text-lg font-bold text-center mb-4">עריכת פריט</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">שם</label>
              <input value={item.name || ""} onChange={e => onChange({...item, name: e.target.value})}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400" />
            </div>
            {pricingEnabled && (itemHasAnyBarcode(item) || item.originalName) && (
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 space-y-1">
                {item.originalName && (
                  <div className="text-xs text-gray-500">השם שהזנת במקור: <span className="font-medium text-gray-700">{item.originalName}</span></div>
                )}
                {(function() {
                  // Group vendors that share the exact same barcode into one
                  // line instead of repeating it once per vendor — the common
                  // case for packaged goods, since a real GTIN doesn't change
                  // by chain. Only genuinely different barcodes (butcher/deli
                  // items priced by weight) get their own line.
                  var byBarcode = {};
                  VENDOR_LIST.forEach(function(v) {
                    var bc = itemVendorBarcode(item, v.id);
                    if (!bc) return;
                    if (!byBarcode[bc]) byBarcode[bc] = [];
                    byBarcode[bc].push(v.label);
                  });
                  return Object.entries(byBarcode).map(function(entry) {
                    var bc = entry[0], labels = entry[1];
                    return (
                      <div key={bc} className="text-xs text-gray-500" dir="ltr">{labels.join(", ")} — ברקוד: <span className="font-mono text-gray-700">{bc}</span></div>
                    );
                  });
                })()}
                <button onClick={() => onResetMatch(item)}
                  className="text-xs text-blue-600 font-medium">🔄 חפש התאמת פריט מחדש</button>
                {/* Item already matched for at least one vendor — the still-
                    missing one(s) are surfaced here instead of on the main
                    list, since "prices already showing" + "still needs
                    matching" reads as contradictory in the list view. */}
                {itemHasAnyBarcode(item) && priceCandidates && priceCandidates.list && (
                  <button onClick={() => { onPickPrice(); onClose(); }}
                    className="text-xs text-blue-600 font-medium block">
                    {priceCandidates.list.length > 0 ? "🔍 השלם התאמה לרשת החסרה" : "⚠ לא נמצא ברקוד לרשת החסרה — חפש ידנית"}
                  </button>
                )}
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">כמות</label>
                <div className="relative">
                  <input type="number" min="0.1" step="0.1" value={item.quantity || ""} onChange={e => onChange({...item, quantity: e.target.value})}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-center focus:outline-none focus:border-blue-400 pr-8" />
                  {item.quantity ? (
                    <button onClick={() => onChange({...item, quantity: ""})}
                      className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 text-base leading-none">✕</button>
                  ) : null}
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">יחידה</label>
                <select value={item.unit || "יחידות"} onChange={e => onChange({...item, unit: e.target.value})}
                  className="w-full border border-gray-200 rounded-xl px-3 py-3 text-right focus:outline-none focus:border-blue-400 bg-white">
                  {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">קטגוריה</label>
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {categories.map(cat => (
                  <button key={cat.id} onClick={() => onChange({...item, category: cat.label})}
                    className={`text-xs px-2.5 py-1 rounded-full border transition ${item.category===cat.label?"bg-blue-600 text-white border-blue-600":"bg-white text-gray-600 border-gray-200"}`}>
                    {cat.emoji} {cat.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">הערה</label>
              <input value={item.note || ""} onChange={e => onChange({...item, note: e.target.value})} placeholder="אופציונלי"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400" />
            </div>
          </div>
          <button onClick={() => onSave(item)} disabled={!item.name || !item.name.trim()}
            className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold mt-5 disabled:opacity-40">
            שמור שינויים
          </button>
        </Modal>
      );
    }

    // ── ADD SCREEN ────────────────────────────────────────────────────────────────
    function AddScreen({ user, listId, listType, listName, onBack, showToast, showStickyToast }) {
      const isTasks = listType === "tasks";
      const isNotes = listType === "notes";
      const categories = useCategories(user.uid);
      const [listDisplayName] = useState(listName || "");
      const [mode,        setMode]       = useState(function() { return localStorage.getItem("buli_add_mode") || "text"; });
      const [inputText,   setInputText]  = useState("");
      const [interimText, setInterimText]= useState("");
      const [isRecording, setIsRecording]= useState(false);
      const [processing,  setProcessing] = useState(false);
      const [saving,      setSaving]     = useState(false);
      const [error,       setError]      = useState("");
      const [taskName,    setTaskName]   = useState("");
      const [taskNote,    setTaskNote]   = useState("");
      const [taskDueDate, setTaskDueDate]= useState(new Date().toISOString().split("T")[0]);
      const [taskSaving,  setTaskSaving] = useState(false);
      const [existingItems, setExistingItems] = useState([]);
      const stopRef        = useRef(null);
      const heldRef        = useRef(false);
      const categoriesRef  = useRef(DEFAULT_CATEGORIES);
      useEffect(function() { if (categories.length > 0) categoriesRef.current = categories; }, [categories]);

      useEffect(function() {
        if (!isTasks) {
          db.ref("items/" + listId).once("value").then(function(snap) {
            var arr = [];
            snap.forEach(function(c) { arr.push(c.val()); });
            setExistingItems(arr);
          });
        }
      }, [listId]);
      const textareaRef = useRef(null);
      const micRef = useRef(null);

      const changeMode = (v) => { setMode(v); localStorage.setItem("buli_add_mode", v); setError(""); };

      useEffect(function() {
        if (mode === "text") {
          setTimeout(function() { if (textareaRef.current) textareaRef.current.focus(); }, 50);
        } else {
          setTimeout(function() { if (micRef.current) micRef.current.focus(); }, 50);
        }
      }, [mode]);

      const startRec = () => {
        setInterimText(""); setIsRecording(true); setError("");
        heldRef.current = true;
        function doStart() {
          if (!heldRef.current) return;
          stopRef.current = startSpeech({
            onResult: function(text, isFinal) {
              if (isFinal) {
                setInputText(function(prev) { return prev ? prev + " " + text.trim() : text.trim(); });
                setInterimText("");
              } else {
                setInterimText(text);
              }
            },
            onEnd: function() {
              setInterimText("");
              if (heldRef.current) { doStart(); } else { setIsRecording(false); }
            },
            onError: function(err) {
              if (err) setError(err);
              if (heldRef.current) { setTimeout(doStart, 100); } else { setIsRecording(false); }
            }
          });
        }
        doStart();
      };
      const stopRec = () => { heldRef.current = false; if (stopRef.current) { stopRef.current(); stopRef.current = null; } setIsRecording(false); setInterimText(""); };

      const saveItems = (itemsArr, cats) => {
        if (!itemsArr.length) return;

        // Detect duplicates against active (not-done) items already in the list
        var activeNames = existingItems
          .filter(function(i) { return !i.done; })
          .map(function(i) { return (i.name || "").trim().toLowerCase(); });
        var dupeNames = [];
        var toAdd = itemsArr.filter(function(item) {
          var n = ((item.name || item.item || "").trim()).toLowerCase();
          if (activeNames.indexOf(n) !== -1) { dupeNames.push((item.name || item.item || "").trim()); return false; }
          return true;
        });
        if (dupeNames.length > 0) showStickyToast(dupeNames);
        if (!toAdd.length) return;

        setSaving(true);
        var catEmojis = {};
        var validCats = new Set();
        var activeCats = (cats && cats.length > 0) ? cats : categoriesRef.current;
        activeCats.forEach(function(c) { catEmojis[c.label] = c.emoji; validCats.add(c.label); });
        var now = Date.now();
        var pos = 0;
        function saveNext() {
          if (pos >= toAdd.length) {
            showToast(toAdd.length + " פריטים נוספו!");
            setSaving(false);
            onBack();
            return;
          }
          var item = toAdd[pos++];
          var aiCat = (item.category || "").trim();
          var cat = validCats.has(aiCat) ? aiCat : "שונות";
          db.ref("items/" + listId).push({
            name:          ((item.name || item.item || "").trim()) || "פריט",
            category:      cat,
            categoryEmoji: catEmojis[cat] || "🛍️",
            quantity:      parseFloat(item.quantity) || 1,
            unit:          item.unit || "יחידות",
            note:          item.note || "",
            dueDate:       "",
            done:          false,
            addedBy:       user.uid,
            addedByName:   user.displayName,
            addedByColor:  getUserColor(user.uid),
            createdAt:     now + pos
          }).then(saveNext, function(err) {
            showToast("שגיאה בשמירה: " + (err && err.message));
            setSaving(false);
          });
        }
        saveNext();
      };

      const process = () => {
        var t = inputText.trim();
        if (!t) return;
        setProcessing(true); setError("");
        var catsSnapshot = categoriesRef.current.slice();
        db.ref("users/" + user.uid + "/ai").once("value").then(function(snap) {
          var ai = snap.val();
          if (!ai || !ai.provider) {
            setError("יש להגדיר ספק AI תחילה — הגדרות ← הגדרות AI");
            setProcessing(false);
            return null;
          }
          return parseWithAI(t, catsSnapshot, ai).then(function(items) {
            if (!items || !items.length) { setError("לא זוהו פריטים בטקסט"); setProcessing(false); return; }
            setProcessing(false);
            saveItems(items, catsSnapshot);
          });
        }).catch(function(e) { setError(e.message || "שגיאה בחיבור ל-AI"); setProcessing(false); });
      };

      const saveTask = () => {
        if (!taskName.trim()) return;
        setTaskSaving(true);
        db.ref("items/" + listId).push({
          name:          taskName.trim(),
          note:          taskNote,
          dueDate:       taskDueDate,
          done:          false,
          category:      "מטלה",
          categoryEmoji: "✅",
          quantity:      1,
          unit:          "יחידות",
          addedBy:       user.uid,
          addedByName:   user.displayName,
          addedByColor:  getUserColor(user.uid),
          createdAt:     Date.now()
        }).then(function() {
          showToast("מטלה נוספה!");
          onBack();
        }, function(err) {
          showToast("שגיאה: " + (err && err.message));
          setTaskSaving(false);
        });
      };

      const notesSeparator = localStorage.getItem("buli_notes_separator") || "הבא";
      const parseDishes = function(text) {
        var sep = notesSeparator.trim();
        var pattern = sep ? new RegExp("\\n|" + sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi") : /\n/g;
        return text.split(pattern).map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
      };

      const saveNotes = function() {
        var dishes = parseDishes(inputText);
        if (!dishes.length) return;
        setSaving(true);
        var now = Date.now();
        var pos = 0;
        function saveNext() {
          if (pos >= dishes.length) {
            showToast(dishes.length + " מנות נוספו!");
            setSaving(false);
            onBack();
            return;
          }
          db.ref("items/" + listId).push({
            name: dishes[pos], done: false, order: pos,
            addedBy: user.uid, addedByName: user.displayName,
            addedByColor: getUserColor(user.uid), createdAt: now + pos
          }).then(function() { pos++; saveNext(); }, function(err) {
            showToast("שגיאה: " + (err && err.message));
            setSaving(false);
          });
        }
        saveNext();
      };

      if (isNotes) {
        return (
          <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
            <Header onBack={onBack} title={"הוסף מנות ל" + (listName || "")} />
            <div className="flex-shrink-0 px-4 pt-3 pb-2">
              <div className="grid grid-cols-2 gap-2">
                {[["text","✍️ כתיבה"],["voice","🎤 קול"]].map(function(pair) {
                  var v = pair[0], l = pair[1];
                  return (
                    <button key={v} onClick={function() { changeMode(v); }}
                      className={"py-3 rounded-xl text-sm font-semibold border transition " + (mode===v ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200")}>{l}</button>
                  );
                })}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-2 pt-3">
              {mode === "text" ? (
                <textarea ref={textareaRef} value={inputText}
                  onChange={function(e) {
                    setInputText(e.target.value);
                    e.target.style.height = "auto";
                    e.target.style.height = e.target.scrollHeight + "px";
                  }}
                  dir="rtl"
                  placeholder={"לדוגמה:\nסלט ירקות\nסלט וולדורף\nסלט חצילים\nמרק עוף\nעוף בתנור\n\nאפשר גם לכתוב '" + notesSeparator + "' בין מנות"}
                  rows={4}
                  style={{minHeight:"140px", height:"auto"}}
                  className="w-full border border-gray-200 bg-white rounded-2xl p-4 text-right resize-none focus:outline-none focus:border-blue-400 text-gray-800 text-sm" />
              ) : (
                <div className="flex flex-col items-center py-8 gap-4">
                  <button ref={micRef}
                    onPointerDown={function(e) { e.preventDefault(); startRec(); }}
                    onPointerUp={stopRec}
                    onPointerCancel={stopRec}
                    style={{ touchAction: "none", userSelect: "none" }}
                    className={"w-28 h-28 rounded-full text-5xl flex items-center justify-center shadow-xl transition select-none " + (isRecording ? "bg-red-500 recording-btn" : "bg-blue-600")}>
                    🎤
                  </button>
                  <p className="text-sm text-gray-400">{isRecording ? "מקליט... שחרר לעצירה" : "לחץ והחזק להקלטה"}</p>
                  <p className="text-xs text-gray-400 text-center">אמור <span className="font-semibold text-gray-600">"{notesSeparator}"</span> כדי לעבור למנה הבאה</p>
                  {(inputText || interimText) && (
                    <div className="w-full bg-white rounded-2xl p-4 border border-gray-100 text-right">
                      <p className="text-gray-700 text-sm">{inputText}</p>
                      {interimText && <p className="text-gray-300 italic text-sm mt-1">{interimText}</p>}
                    </div>
                  )}
                </div>
              )}
              {error && <p className="text-red-500 text-sm text-center mt-3">{error}</p>}
            </div>
            {!isRecording && (
              <div className="flex-shrink-0 px-4 pb-6 pt-2 bg-gray-50 border-t border-gray-100">
                <button onClick={saveNotes} disabled={!inputText.trim() || saving}
                  className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold text-base disabled:opacity-40 flex items-center justify-center gap-2">
                  {saving ? <><Spinner /><span>שומר...</span></> : "הוסף מנות"}
                </button>
              </div>
            )}
          </div>
        );
      }

      if (isTasks) return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <Header onBack={onBack} title="הוסף מטלה" />
          <div className="flex-1 overflow-y-auto p-4 pb-32">
            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-500 block mb-1">שם המטלה</label>
                <input value={taskName} onChange={e => setTaskName(e.target.value)} placeholder="מה צריך לעשות?" dir="rtl" autoFocus
                  className="w-full border border-gray-200 bg-white rounded-2xl p-4 text-right focus:outline-none focus:border-blue-400 text-gray-800 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">תיאור</label>
                <textarea value={taskNote} onChange={e => setTaskNote(e.target.value)} rows={4} placeholder="פרטים נוספים... (אופציונלי)" dir="rtl"
                  className="w-full border border-gray-200 bg-white rounded-2xl p-4 text-right resize-none focus:outline-none focus:border-blue-400 text-gray-800 text-sm" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">תאריך יעד</label>
                <input type="date" value={taskDueDate} onChange={e => setTaskDueDate(e.target.value)}
                  className="w-full border border-gray-200 bg-white rounded-2xl p-4 focus:outline-none focus:border-blue-400" />
              </div>
            </div>
          </div>
          <div className="flex-shrink-0 px-4 pb-6 pt-3 bg-gray-50 border-t border-gray-100">
            <button onClick={saveTask} disabled={!taskName.trim() || taskSaving}
              className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold text-lg disabled:opacity-40 flex items-center justify-center gap-2">
              {taskSaving ? <Spinner /> : "הוסף מטלה"}
            </button>
          </div>
        </div>
      );

      // ── Input ──
      return (
        <div className="bg-gray-50 flex flex-col" style={{height:"100dvh"}}>
          <Header onBack={onBack} title={isTasks ? "הוסף מטלה" : ("הוסף ל" + listDisplayName)} />
          <div className="flex-shrink-0 px-4 pt-3 pb-2">
            <div className="grid grid-cols-2 gap-2">
              {[["text","✍️ כתיבה"],["voice","🎤 קול"]].map(([v,l]) => (
                <button key={v} onClick={() => changeMode(v)}
                  className={`py-3 rounded-xl text-sm font-semibold border transition ${mode===v?"bg-blue-600 text-white border-blue-600":"bg-white text-gray-600 border-gray-200"}`}>{l}</button>
              ))}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-2 pt-3">
            {mode === "text" ? (
              <textarea ref={textareaRef} value={inputText}
                onChange={function(e) {
                  setInputText(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = e.target.scrollHeight + "px";
                }}
                dir="rtl"
                placeholder={isTasks ? "לדוגמה:\nלקנות מתנה למירי\nלשלם חשבון חשמל\nלתאם תור לרופא\nלאסוף את הילדים ב-16:00" : "לדוגמה:\n3 ק״ג עגבניות\nחלב 3% שני ליטר\nסבון כלים\n6 ביצים"}
                rows={3}
                style={{minHeight:"120px", height:"auto"}}
                className="w-full border border-gray-200 bg-white rounded-2xl p-4 text-right resize-none focus:outline-none focus:border-blue-400 text-gray-800 text-sm" />
            ) : (
              <div className="flex flex-col items-center py-8 gap-4">
                <button ref={micRef}
                  onPointerDown={function(e) { e.preventDefault(); startRec(); }}
                  onPointerUp={stopRec}
                  onPointerCancel={stopRec}
                  style={{ touchAction: "none", userSelect: "none" }}
                  className={`w-28 h-28 rounded-full text-5xl flex items-center justify-center shadow-xl transition select-none ${isRecording ? "bg-red-500 recording-btn" : "bg-blue-600"}`}>
                  🎤
                </button>
                <p className="text-sm text-gray-400">{isRecording ? "מקליט... שחרר לעצירה" : "לחץ והחזק להקלטה"}</p>
                {(inputText || interimText) && (
                  <div className="w-full bg-white rounded-2xl p-4 border border-gray-100 text-right">
                    <p className="text-gray-700 text-sm">{inputText}</p>
                    {interimText && <p className="text-gray-300 italic text-sm mt-1">{interimText}</p>}
                  </div>
                )}
              </div>
            )}
            {error && <p className="text-red-500 text-sm text-center mt-3">{error}</p>}
          </div>

          {!isRecording && (
            <div className="flex-shrink-0 px-4 pb-6 pt-2 bg-gray-50 border-t border-gray-100">
              <button onClick={process} disabled={!inputText.trim() || processing || saving}
                className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold text-base disabled:opacity-40 flex items-center justify-center gap-2">
                {saving ? <><Spinner /><span>שומר...</span></> : processing ? <><Spinner /><span>מנתח עם AI...</span></> : "הוסף לרשימה"}
              </button>
            </div>
          )}

        </div>
      );
    }

    ReactDOM.createRoot(document.getElementById("root")).render(<App />);
