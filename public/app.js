    const { useState, useEffect, useRef } = React;

    const VERSION = "v6.78";

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

    // Alphabetical (Hebrew-aware) — shared by the home screen's own list
    // order and the "copy items" destination picker, so a list never
    // appears in a different order in one place than the other.
    function sortListsByName(lists) {
      return lists.slice().sort(function(a, b) {
        return (a.name || "").localeCompare(b.name || "", "he");
      });
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
    function Modal({ onClose, children, disableClose, footer }) {
      const [dragY, setDragY] = React.useState(0);
      const startYRef = React.useRef(null);
      const handleRef = React.useRef(null);

      const onPointerDown = (e) => {
        if (disableClose) return;
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
        <div className="fixed inset-0 bg-black/40 z-40 flex items-end" onClick={disableClose ? undefined : onClose}>
          <div className="relative bg-white w-full max-w-md sm:max-w-lg md:max-w-xl mx-auto rounded-t-3xl flex flex-col"
            style={{ transform: "translateY(" + dragY + "px)", transition: dragY === 0 ? "transform 0.2s ease" : "none", maxHeight: "88dvh" }}
            onClick={e => e.stopPropagation()}>
            <div className="relative flex-shrink-0 px-6 pt-6">
              <div ref={handleRef}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                className={"w-10 h-1.5 bg-gray-200 rounded-full mx-auto mb-4 " + (disableClose ? "" : "cursor-grab active:cursor-grabbing touch-none")} />
              {!disableClose && (
                <button onClick={onClose} className="absolute top-4 left-4 text-gray-400 hover:text-gray-600 text-2xl leading-none w-8 h-8 flex items-center justify-center">×</button>
              )}
            </div>
            {/* flex-1 + min-h-0 lets this shrink so a sticky footer (below)
                always stays on screen without needing to scroll past the
                form to reach it — the sheet still auto-sizes to short
                content since nothing here forces height when there's no
                overflow. */}
            <div className={"overflow-y-auto px-6 min-h-0 flex-1 " + (footer ? "pb-4" : "pb-8")}>
              {children}
            </div>
            {footer && (
              <div className="flex-shrink-0 px-6 pt-3 pb-6 border-t border-gray-100">
                {footer}
              </div>
            )}
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
    function Header({ onBack, title, right, onMenu }) {
      return (
        <div className="bg-blue-600 text-white px-4 pt-6 pb-4">
          <div className="flex items-center gap-3" dir="ltr">
            {onBack && (
              <button onClick={onBack} className="flex items-center gap-1 text-white font-semibold text-sm bg-white/20 px-3 py-1.5 rounded-full flex-shrink-0">
                <span className="text-lg leading-none">‹</span><span>חזרה</span>
              </button>
            )}
            {onMenu && (
              <button onClick={onMenu} className="text-white text-lg w-9 h-9 flex items-center justify-center bg-white/20 rounded-full flex-shrink-0">☰</button>
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
    // Shopping-item "in the basket" toggle — an empty basket outline, filled
    // with an item silhouette once checked, instead of a generic checkbox.
    // Same checked/onChange contract as Checkbox so it drops in wherever an
    // item's done-state is toggled.
    function BasketToggle({ checked, onChange }) {
      return (
        <button type="button" onClick={onChange}
          className="w-8 h-8 flex-shrink-0 flex items-center justify-center" aria-label="סמן כנלקח">
          <svg viewBox="0 0 24 24" className="w-6 h-6">
            <path d="M8 8 10 4h4l2 4" fill="none" stroke={checked ? "#2563eb" : "#9ca3af"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 8h16l-1.4 9.8a2 2 0 0 1-2 1.7H7.4a2 2 0 0 1-2-1.7L4 8Z"
              fill={checked ? "#dbeafe" : "white"} stroke={checked ? "#2563eb" : "#9ca3af"} strokeWidth="1.6" strokeLinejoin="round" />
            {checked && <circle cx="12" cy="13.5" r="2.6" fill="#2563eb" />}
          </svg>
        </button>
      );
    }

    // ── APP ───────────────────────────────────────────────────────────────────────
    function App() {
      const [user,        setUser]        = useState(null);
      const [loading,     setLoading]     = useState(true);
      const [role,        setRole]        = useState(null);
      // The ☰ menu button lives on every screen now, not just Home — since
      // Settings itself is a big chunk of HomeScreen-local state (users...),
      // the other screens don't open it directly; they navigate home and set
      // this flag, which HomeScreen picks up on arrival to open Settings itself.
      const [autoOpenSettings, setAutoOpenSettings] = useState(false);
      // Text size is a personal accessibility preference, applied globally
      // by scaling the root element's font-size — every Tailwind text-*
      // class here is defined in rem, so this one line scales the whole
      // app (any screen, any device) instead of hunting down every
      // className. Cached in localStorage for an instant-correct size on
      // the very next load, before the DB read (below) even resolves.
      const [fontScale, setFontScaleState] = useState(function() {
        return parseInt(localStorage.getItem("buli_font_scale"), 10) || 100;
      });
      const setFontScale = function(v) {
        setFontScaleState(v);
        localStorage.setItem("buli_font_scale", v);
        if (user) db.ref("users/" + user.uid + "/fontScale").set(v);
      };
      useEffect(function() {
        document.documentElement.style.fontSize = fontScale + "%";
      }, [fontScale]);
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
            db.ref("users/" + u.uid + "/fontScale").once("value").then(function(snap) {
              var v = snap.val();
              if (v && v !== parseInt(localStorage.getItem("buli_font_scale"), 10)) {
                setFontScaleState(v);
                localStorage.setItem("buli_font_scale", v);
              }
            });
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
      // ☰ tapped from another screen navigates home and sets autoOpenSettings
      // (declared up top with the other useState calls — see below), which
      // HomeScreen picks up on arrival to open Settings itself.
      const goMenu = () => { setAutoOpenSettings(true); goHome(); };

      return (
        <div className="max-w-md sm:max-w-xl md:max-w-2xl lg:max-w-3xl xl:max-w-4xl mx-auto min-h-screen relative">
          {simulateRegular && (
            <button onClick={() => toggleSimulate(false)}
              className="fixed top-2 left-1/2 -translate-x-1/2 z-50 bg-black/70 text-white text-xs font-medium px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5">
              <span>👁️ תצוגת משתמש רגיל</span><span className="opacity-70">· חזרה למנהל</span>
            </button>
          )}
          {screen === "home"       && <HomeScreen       user={user} isAdmin={role === "admin" && !simulateRegular} isRealAdmin={role === "admin"} simulating={simulateRegular} onToggleSimulate={toggleSimulate} onOpenList={goList} onCategories={() => go("categories")} showToast={setToast} onAddTask={() => goAdd("tasks_" + user.uid, "tasks")} onCreateShoppingList={(id, name) => goAdd(id, "shopping", name)} onCreateNotesList={(id, name) => goAdd(id, "notes", name)} autoOpenSettings={autoOpenSettings} onAutoOpenedSettings={() => setAutoOpenSettings(false)} fontScale={fontScale} onSetFontScale={setFontScale} />}
          {screen === "list"       && <ListScreen       user={user} listId={listId} onBack={goBack} onMenu={goMenu} onHome={goHome} onAdd={(type, name) => goAdd(listId, type, name || listName)} showToast={setToast} />}
          {screen === "add"        && <AddScreen        user={user} listId={listId} listType={listType} listName={listName} onBack={goBack} onMenu={goMenu} showToast={setToast} showStickyToast={setStickyToast} />}
          {screen === "categories" && <CategoriesScreen user={user} onBack={goBack} showToast={setToast} />}
          {toast && <Toast msg={toast} onClose={() => setToast("")} />}
          {stickyToast.length > 0 && (
            <div onClick={() => setStickyToast([])}
              className="fixed bottom-24 left-1/2 -translate-x-1/2 w-11/12 max-w-md bg-amber-50 border border-amber-300 rounded-2xl px-4 py-3 z-50 shadow-lg cursor-pointer">
              {stickyToast.map(function(block, i) {
                return (
                  <div key={i} className={i > 0 ? "mt-2 pt-2 border-t border-amber-200" : ""}>
                    <p className="font-semibold text-amber-800 text-sm mb-1">{block.title}</p>
                    <p className="text-amber-700 text-sm leading-relaxed">{block.lines.join(" · ")}</p>
                  </div>
                );
              })}
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
        <div className="relative flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-blue-50 to-white px-6">
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
          <p className="absolute bottom-4 text-gray-300 text-xs">© {new Date().getFullYear()} בולי • כל הזכויות שמורות</p>
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
    function HomeScreen({ user, isAdmin, isRealAdmin, simulating, onToggleSimulate, onOpenList, onCategories, showToast, onAddTask, onCreateShoppingList, onCreateNotesList, autoOpenSettings, onAutoOpenedSettings, fontScale, onSetFontScale }) {
      const tasksListId = "tasks_" + user.uid;
      const creatingListRef = useRef(false);
      const categories = useCategories(user.uid); // for grouping the "copy items" picker by category, same as a list's default view
      const [lists,      setLists]      = useState(function() { return homeDataCache ? homeDataCache.lists : null; });
      const [tasks,      setTasks]      = useState(function() { return homeDataCache ? homeDataCache.tasks : null; });
      // Every local mutation of `lists` must also update homeDataCache, or the
      // next "back to menu" reuses the pre-mutation snapshot (prewarmHomeData
      // only re-fetches when the cache is empty) — this was why adding/removing
      // a list looked like it needed a full page reload to actually show up.
      //
      // The cache write happens directly here, synchronously, NOT inside the
      // setLists updater callback — creating a list immediately navigates
      // away to AddScreen in the very same tick (see onCreateShoppingList
      // below), and when a setState call and a navigation-away both land in
      // the same batch, React can unmount HomeScreen before ever invoking
      // its queued updater, silently dropping a cache write placed there.
      // A plain module-level assignment has no such dependency on whether
      // the component sticks around to render again.
      const updateLists = function(updater) {
        var next = typeof updater === "function" ? updater(lists) : updater;
        if (homeDataCache) homeDataCache = Object.assign({}, homeDataCache, { lists: next });
        setLists(next);
      };
      const [loadError,  setLoadError]  = useState(null);
      const [editTask,   setEditTask]   = useState(null);
      const [menuId,     setMenuId]     = useState(null);
      const [showDone,   setShowDone]   = useState(false);
      const [renameId,   setRenameId]   = useState(null);
      const [renameName, setRenameName] = useState("");
      const [duplicateId,   setDuplicateId]   = useState(null);
      const [duplicateName, setDuplicateName] = useState("");
      const [duplicating, setDuplicating] = useState(false);
      const [copySourceList,   setCopySourceList]   = useState(null);
      const [copyItems,        setCopyItems]        = useState([]);
      const [copyItemsLoading, setCopyItemsLoading] = useState(false);
      const [showCopyPicker,   setShowCopyPicker]   = useState(false);
      const [copySelectedIds,  setCopySelectedIds]  = useState([]);
      const [showCopyDest,     setShowCopyDest]     = useState(false);
      const [copyNewListMode,  setCopyNewListMode]  = useState(false);
      const [copyNewListName,  setCopyNewListName]  = useState("");
      const [copyBusy,         setCopyBusy]         = useState(false);

      const _isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      const _isInstalled = window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone;
      // Show the install option to every role, not just whichever device happened to
      // have already fired the native beforeinstallprompt — browsers that never fire
      // it (or haven't yet) fall back to the generic on-screen guide below.
      const [canInstall, setCanInstall] = useState(!_isInstalled);
      const [showInstallGuide, setShowInstallGuide] = useState(false);

      const [showSettings, setShowSettings] = useState(false);
      const [showProfileCard, setShowProfileCard] = useState(false);
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

      const [myMenusEnabled, setMyMenusEnabled] = useState(false);
      const [myTasksEnabled, setMyTasksEnabled] = useState(false);
      const [myKeyboardWarning, setMyKeyboardWarning] = useState(true);
      const [myNickname, setMyNickname] = useState("");
      // Remembers the last tab per user (not just per session) so reopening
      // Settings later — even after a full reload — lands back where they
      // left off instead of always resetting to כללי.
      const [settingsTab, setSettingsTab] = useState(function() {
        var saved = localStorage.getItem("buli_settings_tab_" + user.uid);
        return saved === "users" ? "users" : "general"; // stale "vendors" from before the feature was removed falls back to general
      }); // "general" | "users"
      const [contactMembers, setContactMembers] = useState(null);

      useEffect(function() {
        Promise.all([
          db.ref("users/" + user.uid + "/menusEnabled").once("value"),
          db.ref("users/" + user.uid + "/tasksEnabled").once("value"),
          db.ref("users/" + user.uid + "/keyboardWarning").once("value"),
          db.ref("users/" + user.uid + "/nickname").once("value"),
        ]).then(function(snaps) {
          // Defaults for a brand-new user who's never touched these: menus
          // off, tasks off, wrong-keyboard-language beep on.
          setMyMenusEnabled(snaps[0].val() === true);
          setMyTasksEnabled(snaps[1].val() === true);
          setMyKeyboardWarning(snaps[2].val() !== false);
          setMyNickname(snaps[3].val() || "");
        });
      }, [user.uid]);

      const API_KEY_LINKS = {
        anthropic: "https://console.anthropic.com/settings/keys",
        openai:    "https://platform.openai.com/api-keys",
        gemini:    "https://aistudio.google.com/apikey"
      };

      // ── Manage Users (admin only) ──────────────────────────────────────────────
      const [showUsers,   setShowUsers]   = useState(false);
      const [usersLoading, setUsersLoading] = useState(false);
      const [authUsers,   setAuthUsers]   = useState([]);
      const [selfUserInfo, setSelfUserInfo] = useState(null);
      const [ownerEmail,  setOwnerEmail]  = useState("");
      const [ownerMenusEnabled, setOwnerMenusEnabled] = useState(false);
      const [ownerTasksEnabled, setOwnerTasksEnabled] = useState(false);
      const [ownerKeyboardWarning, setOwnerKeyboardWarning] = useState(true);
      const [ownerNickname, setOwnerNickname] = useState("");
      const [ownerLastLogin, setOwnerLastLogin] = useState(null);
      const [newUserEmail, setNewUserEmail] = useState("");
      const [newUserRole,  setNewUserRole]  = useState("user");
      const [userBusy,    setUserBusy]    = useState(false);
      const [userMsg,     setUserMsg]     = useState("");

      // Lazy-loaded the first time the "משתמשים" settings tab opens, not on
      // every HomeScreen mount — same pattern as the other collapsible
      // settings sections, just triggered by the tab instead of a toggle.
      const [showContacts, setShowContacts] = useState(false);
      const loadContacts = function() {
        if (contactMembers !== null) return;
        fns.httpsCallable("listTeamMembers")().then(function(res) {
          var others = (res.data.members || []).filter(function(m) { return m.uid !== user.uid; });
          db.ref("shareDefaults").once("value").then(function(snap) {
            var defaults = snap.val() || {};
            others.sort(function(a, b) { return (a.name || "").localeCompare(b.name || "", "he"); });
            setContactMembers(others.map(function(m) { return Object.assign({}, m, { alwaysShare: !!defaults[m.uid] }); }));
          });
        }, function() { setContactMembers([]); showToast("שגיאה בטעינת אנשי קשר"); });
      };

      const toggleContactAlwaysShare = function(uid) {
        var next;
        setContactMembers(function(prev) {
          return prev.map(function(m) {
            if (m.uid !== uid) return m;
            next = !m.alwaysShare;
            return Object.assign({}, m, { alwaysShare: next });
          });
        });
        db.ref("shareDefaults/" + uid).set(next || null);
      };

      const loadAuthUsers = () => {
        setUsersLoading(true);
        fns.httpsCallable("listAuthorizedUsers")().then(function(res) {
          if (res.data.self) {
            setSelfUserInfo(res.data.self);
          } else {
            setOwnerEmail(res.data.owner || "");
            setOwnerMenusEnabled(!!res.data.ownerMenusEnabled);
            setOwnerTasksEnabled(!!res.data.ownerTasksEnabled);
            setOwnerKeyboardWarning(res.data.ownerKeyboardWarning !== false);
            setOwnerNickname(res.data.ownerNickname || "");
            setOwnerLastLogin(res.data.ownerLastLogin || null);
            setAuthUsers(res.data.users || []);
          }
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
      // One callable for the other three per-user preferences — pass just
      // the one(s) changing, same self-or-admin gate as nickname.
      const handleSetUserPref = (email, patch) => {
        setUserBusy(true); setUserMsg("");
        fns.httpsCallable("setUserPreferences")(Object.assign({ email: email }, patch)).then(function() {
          setUserBusy(false);
          if (email.trim().toLowerCase() === (user.email || "").toLowerCase()) {
            if ("menusEnabled" in patch) setMyMenusEnabled(patch.menusEnabled);
            if ("tasksEnabled" in patch) setMyTasksEnabled(patch.tasksEnabled);
            if ("keyboardWarning" in patch) setMyKeyboardWarning(patch.keyboardWarning);
          }
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
      // Personal display preferences — plain self-only fields (rules already
      // allow a user to write their own users/{uid}/* besides the two
      // special-cased ones), so no callable round-trip is needed here.
      const setMyMenusEnabledPref = function(v) { setMyMenusEnabled(v); db.ref("users/" + user.uid + "/menusEnabled").set(v); };
      const setMyTasksEnabledPref = function(v) { setMyTasksEnabled(v); db.ref("users/" + user.uid + "/tasksEnabled").set(v); };
      const setMyKeyboardWarningPref = function(v) { setMyKeyboardWarning(v); db.ref("users/" + user.uid + "/keyboardWarning").set(v); };

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

      // Every collapsible sub-section starts closed on a fresh tab, rather
      // than carrying over whatever was left open from the last time this
      // or another tab was visited — landing on a tab full of already-open
      // panels reads as cluttered/confusing.
      const switchSettingsTab = function(tab) {
        setSettingsTab(tab);
        localStorage.setItem("buli_settings_tab_" + user.uid, tab);
        setShowAISettings(false);
        setShowUsers(false);
        setShowContacts(false);
        setShowCosts(false);
      };
      // ☰ tapped from another screen (see App()'s goMenu) — open Settings
      // here on arrival, same as tapping ☰ directly on Home.
      useEffect(function() {
        if (!autoOpenSettings) return;
        switchSettingsTab(settingsTab);
        setShowSettings(true);
        onAutoOpenedSettings();
      }, [autoOpenSettings]);

      const [confirmDialog, setConfirmDialog] = useState(null);
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
      // If the tab the user was last on got disabled (from a previous
      // session, another device, or just now in settings), fall back to
      // shopping rather than rendering a dead tab.
      useEffect(function() {
        if (activeTab === "notes" && !myMenusEnabled) setTab("shopping");
        if (activeTab === "tasks" && !myTasksEnabled) setTab("shopping");
      }, [myMenusEnabled, myTasksEnabled]);
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
        // Guards against double-tap/double-click creating two lists at
        // once — quickCreate reads `lists` (React state) synchronously to
        // pick the next free "#N", so a second tap before the first
        // write's re-render lands would compute the same name and create
        // a genuine duplicate, not just a visual glitch.
        if (creatingListRef.current) return;
        creatingListRef.current = true;
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
          creatingListRef.current = false;
          onCreateShoppingList(newListId, autoName);
        }, function() { creatingListRef.current = false; showToast("שגיאה ביצירת הרשימה"); });
      };

      const quickCreateNote = () => {
        if (creatingListRef.current) return;
        creatingListRef.current = true;
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
          creatingListRef.current = false;
          onCreateNotesList(newListId, autoName);
        }, function() { creatingListRef.current = false; showToast("שגיאה ביצירת התפריט"); });
      };

      const markListDone = (id) => {
        var now = Date.now();
        var newLists = (lists || []).map(function(l) { return l.id === id ? Object.assign({}, l, { done: true, doneAt: now }) : l; });
        updateLists(newLists);
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

      const startDuplicate = (id) => {
        var list = (lists || []).find(function(l) { return l.id === id; });
        setDuplicateId(id); setDuplicateName(list ? "עותק של " + list.name : ""); setMenuId(null);
      };

      const confirmDuplicate = () => {
        if (!duplicateName.trim() || !duplicateId || duplicating) return;
        var original = (lists || []).find(function(l) { return l.id === duplicateId; });
        if (!original) { setDuplicateId(null); return; }
        setDuplicating(true);
        var newName = duplicateName.trim();
        var newId = db.ref("lists").push().key;
        // Copy every field from the original except the ones that must be
        // fresh for a new, unshared list: id (client-side only, never stored),
        // sharedWith (a duplicate starts private to whoever made it), name,
        // ownership/creation time, and completion state.
        var newListData = Object.assign({}, original);
        delete newListData.id;
        delete newListData.sharedWith;
        newListData.name = newName;
        newListData.ownerId = user.uid;
        newListData.createdAt = Date.now();
        newListData.done = false;

        db.ref("items/" + duplicateId).once("value").then(function(snap) {
          var items = snap.val() || {};
          var updates = {};
          updates["lists/" + newId] = newListData;
          updates["listsByUser/" + user.uid + "/" + newId] = true;
          // Items are copied exactly as they are — same name, note, and
          // checked/unchecked state — just filed under new item keys.
          Object.keys(items).forEach(function(itemId) {
            var newItemKey = db.ref("items/" + newId).push().key;
            updates["items/" + newId + "/" + newItemKey] = items[itemId];
          });
          return db.ref().update(updates);
        }).then(function() {
          updateLists(function(prev) { return (prev || []).concat([Object.assign({ id: newId }, newListData)]); });
          setDuplicateId(null); setDuplicating(false);
          showToast("הרשימה שוכפלה");
        }, function(err) {
          setDuplicating(false);
          showToast("שגיאה בשכפול: " + (err && err.message || "?"));
        });
      };

      const startCopyItems = (id) => {
        var list = (lists || []).find(function(l) { return l.id === id; });
        if (!list) return;
        setMenuId(null);
        setCopySourceList(list);
        setCopySelectedIds([]);
        setCopyItemsLoading(true);
        setShowCopyPicker(true);
        db.ref("items/" + id).once("value").then(function(snap) {
          var arr = [];
          snap.forEach(function(c) { arr.push(Object.assign({ id: c.key }, c.val())); });
          arr.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
          setCopyItems(arr);
          setCopyItemsLoading(false);
        }, function() {
          setCopyItemsLoading(false);
          showToast("שגיאה בטעינת הפריטים");
        });
      };
      const toggleCopySelect = (id) => {
        setCopySelectedIds(function(prev) {
          return prev.indexOf(id) === -1 ? prev.concat(id) : prev.filter(function(x) { return x !== id; });
        });
      };
      // Same category grouping + order a list itself shows by default, so
      // the picker reads as "the list, with checkboxes" rather than an
      // unrelated re-shuffled dump of the same items.
      const copyItemsGrouped = function() {
        var catOrder = categories.map(function(c) { return c.label; });
        var catMap = {};
        var seenOrder = [];
        copyItems.forEach(function(i) {
          var c = i.category || "שונות";
          if (!catMap[c]) { catMap[c] = { emoji: i.categoryEmoji || "🛍️", items: [] }; seenOrder.push(c); }
          catMap[c].items.push(i);
        });
        var known = catOrder.filter(function(l) { return catMap[l]; })
          .map(function(l) { return Object.assign({ label: l }, catMap[l]); });
        var unknown = seenOrder.filter(function(l) { return catOrder.indexOf(l) === -1; })
          .map(function(l) { return Object.assign({ label: l }, catMap[l]); });
        return known.concat(unknown);
      };
      const confirmCopySelection = () => {
        if (copySelectedIds.length === 0) return;
        setShowCopyPicker(false);
        setCopyNewListMode(false);
        setCopyNewListName("");
        setShowCopyDest(true);
      };
      // Same-type, not-done, and either owned or add-permitted — a copy is
      // just adding items, so "own" (add-only) role is enough; "view" isn't.
      const copyDestOptions = function() {
        var filtered = (lists || []).filter(function(l) {
          return copySourceList && l.id !== copySourceList.id && l.type !== "notes" && !l.done &&
            (l.ownerId === user.uid || (l.sharedWith && (l.sharedWith[user.uid] === "edit" || l.sharedWith[user.uid] === "own")));
        });
        return sortListsByName(filtered);
      };
      const copyItemsToDest = (destId) => {
        if (copyBusy) return;
        setCopyBusy(true);
        var updates = {};
        copySelectedIds.forEach(function(id) {
          var item = copyItems.find(function(i) { return i.id === id; });
          if (!item) return;
          var newKey = db.ref("items/" + destId).push().key;
          var copy = Object.assign({}, item);
          delete copy.id;
          updates["items/" + destId + "/" + newKey] = copy;
        });
        db.ref().update(updates).then(function() {
          setCopyBusy(false);
          setShowCopyDest(false);
          setCopySourceList(null);
          setCopySelectedIds([]);
          setCopyItems([]);
          showToast(copySelectedIds.length + " פריטים הועתקו");
        }, function(err) {
          setCopyBusy(false);
          showToast("שגיאה בהעתקה: " + (err && err.message || "?"));
        });
      };
      const createListAndCopyItems = () => {
        var name = copyNewListName.trim();
        if (!name || copyBusy) return;
        setCopyBusy(true);
        var now = Date.now();
        var newList = { name: name, type: "shopping", isPrivate: false, done: false, ownerId: user.uid, ownerName: user.displayName, sharedWith: {}, createdAt: now };
        var newListId = db.ref("lists").push().key;
        var updates = {};
        updates["lists/" + newListId] = newList;
        updates["listsByUser/" + user.uid + "/" + newListId] = true;
        copySelectedIds.forEach(function(id) {
          var item = copyItems.find(function(i) { return i.id === id; });
          if (!item) return;
          var newKey = db.ref("items/" + newListId).push().key;
          var copy = Object.assign({}, item);
          delete copy.id;
          updates["items/" + newListId + "/" + newKey] = copy;
        });
        db.ref().update(updates).then(function() {
          setCopyBusy(false);
          setShowCopyDest(false);
          setCopySourceList(null);
          setCopySelectedIds([]);
          setCopyItems([]);
          updateLists(function(prev) { return (prev || []).concat([Object.assign({ id: newListId }, newList)]); });
          showToast(copySelectedIds.length + ' פריטים הועתקו אל "' + name + '"');
        }, function(err) {
          setCopyBusy(false);
          showToast("שגיאה ביצירת הרשימה: " + (err && err.message || "?"));
        });
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
          <div className="bg-blue-600 text-white px-4 pt-6 pb-5 flex-shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="w-9 h-9 flex-shrink-0" />
              <div className="text-center flex-1 min-w-0">
                <div className="flex items-center justify-center gap-1.5">
                  <span className="text-xl">🛒</span>
                  <span className="text-xl font-bold">בולי</span>
                  <span className="text-[10px] text-white/40">{VERSION}</span>
                </div>
                <p className="text-white/50 text-[11px] mt-0.5">אפליקציה לקניות משפחתית</p>
              </div>
              <button onClick={() => auth.signOut()} className="text-xs bg-white/20 px-3 py-1.5 rounded-full flex-shrink-0">יציאה</button>
            </div>
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

      var activeShopping = sortListsByName(lists.filter(function(l) { return !l.done && l.type !== "notes"; }));
      var doneLists      = sortListsByName(lists.filter(function(l) { return  l.done && l.type !== "notes"; }));
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
        onDuplicate:     function() { startDuplicate(l.id); },
        onCopyItems:     function() { startCopyItems(l.id); },
        onDelete:        function() { deleteList(l.id); }
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
          <div className="bg-blue-600 text-white px-4 pt-6 pb-4 flex-shrink-0">
            <div className="flex items-center justify-between gap-2">
              <button onClick={e => { e.stopPropagation(); setShowProfileCard(true); }} title={user.displayName}
                className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0 overflow-hidden">
                {user.photoURL ? <img src={user.photoURL} alt="" className="w-full h-full object-cover" /> : <span className="text-base">👤</span>}
              </button>
              <div className="text-center flex-1 min-w-0">
                <div className="flex items-center justify-center gap-1.5">
                  <span className="text-xl">🛒</span>
                  <span className="text-xl font-bold">בולי</span>
                  <span className="text-[10px] text-white/40">{VERSION}</span>
                </div>
                <p className="text-white/50 text-[11px] mt-0.5">אפליקציה לקניות משפחתית</p>
              </div>
              <button onClick={e => { e.stopPropagation(); switchSettingsTab(settingsTab); setShowSettings(true); }} title="הגדרות"
                className="text-white text-lg w-9 h-9 flex items-center justify-center bg-white/20 rounded-full flex-shrink-0">⚙️</button>
            </div>
          </div>
          {(myMenusEnabled || myTasksEnabled) && (
          <div className="bg-white border-b border-gray-200 flex-shrink-0 flex" dir="rtl">
            {[["shopping","🛒","קניות"],["notes","📝","תפריטים"],["tasks","✅","מטלות"]]
              .filter(function(t) { return t[0] === "shopping" || (t[0] === "notes" && myMenusEnabled) || (t[0] === "tasks" && myTasksEnabled); })
              .map(function(t) {
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
          )}

          <div className="flex-1 overflow-y-auto p-4 pb-24">

            {/* ── Shopping tab ── */}
            {activeTab === "shopping" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
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
            <p className="text-center text-gray-300 text-[11px] mt-6">© {new Date().getFullYear()} בולי • כל הזכויות שמורות</p>
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

          {/* Duplicate list modal */}
          {duplicateId && (
            <Modal onClose={() => { if (!duplicating) setDuplicateId(null); }}>
              <h3 className="text-lg font-bold text-center mb-4">שכפול רשימה</h3>
              <input value={duplicateName} onChange={e => setDuplicateName(e.target.value)} autoFocus
                onKeyDown={e => e.key === "Enter" && confirmDuplicate()}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400 mb-4" />
              <button onClick={confirmDuplicate} disabled={!duplicateName.trim() || duplicating}
                className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold text-lg disabled:opacity-40">
                {duplicating ? "משכפל..." : "שכפל"}
              </button>
            </Modal>
          )}

          {/* Copy items to another list — step 1: pick items */}
          {showCopyPicker && (
            <Modal onClose={() => setShowCopyPicker(false)}>
              <h3 className="text-lg font-bold text-center mb-1">בחר פריטים להעתקה</h3>
              <p className="text-xs text-gray-400 text-center mb-3">{copySelectedIds.length} נבחרו</p>
              {copyItemsLoading ? (
                <div className="flex justify-center py-6"><Spinner /></div>
              ) : (
                <div className="mb-4">
                  {copyItemsGrouped().map(function(group) {
                    return (
                      <div key={group.label} className="mb-4 last:mb-0">
                        <div className="text-xs font-semibold text-gray-400 mb-2 flex items-center gap-1 uppercase tracking-wide">
                          <span>{group.emoji}</span><span>{group.label}</span>
                        </div>
                        <div className="space-y-2">
                          {group.items.map(function(item) {
                            var sel = copySelectedIds.indexOf(item.id) !== -1;
                            return (
                              <button key={item.id} onClick={function() { toggleCopySelect(item.id); }}
                                className={"w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-right transition " + (sel ? "bg-blue-50 border-blue-400" : "bg-white border-gray-200")}>
                                <span className={`w-5 h-5 rounded border-2 flex-shrink-0 flex items-center justify-center transition ${sel ? "bg-blue-600 border-blue-600" : "border-gray-400 bg-white"}`}>
                                  {sel && (
                                    <svg className="w-3 h-3 text-white" viewBox="0 0 12 10" fill="none">
                                      <path d="M1 5l3.5 3.5L11 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </span>
                                <span className={"flex-1 min-w-0 truncate text-sm font-medium " + (item.done ? "line-through text-gray-400" : "text-gray-800")}>{item.name}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  {copyItems.length === 0 && (
                    <p className="text-center text-gray-400 text-sm py-4">אין פריטים ברשימה</p>
                  )}
                </div>
              )}
              {/* Sticky, not just trailing content — with a long list, the
                  confirm bar must stay reachable without scrolling past
                  every item first (the fixed-height box this replaced hid
                  that problem by capping the list to a few visible rows). */}
              <div className="sticky bottom-0 -mx-6 px-6 pt-2 pb-1 bg-white border-t border-gray-100 flex gap-2">
                <button onClick={confirmCopySelection} disabled={copySelectedIds.length === 0}
                  className="flex-1 bg-blue-600 text-white py-3.5 rounded-2xl font-semibold disabled:opacity-40">
                  אישור{copySelectedIds.length > 0 ? " (" + copySelectedIds.length + ")" : ""}
                </button>
                <button onClick={() => setShowCopyPicker(false)} className="flex-1 py-3.5 text-gray-500 font-medium rounded-2xl border border-gray-200">
                  ביטול
                </button>
              </div>
            </Modal>
          )}

          {/* Copy items to another list — step 2: pick (or create) destination */}
          {showCopyDest && (
            <Modal onClose={() => setShowCopyDest(false)}>
              <h3 className="text-lg font-bold text-center mb-4">העתק {copySelectedIds.length} פריטים אל</h3>
              <div className="space-y-2 mb-3">
                {copyDestOptions().map(function(l) {
                  return (
                    <button key={l.id} onClick={function() { copyItemsToDest(l.id); }} disabled={copyBusy}
                      className="w-full text-right px-4 py-3 rounded-xl border border-gray-200 bg-white hover:bg-gray-50 text-sm font-medium text-gray-800 disabled:opacity-50 truncate">
                      {l.name}
                    </button>
                  );
                })}
                {copyDestOptions().length === 0 && (
                  <p className="text-center text-gray-400 text-sm py-2">אין רשימות אחרות זמינות</p>
                )}
              </div>
              {copyNewListMode ? (
                <div className="flex gap-2">
                  <input value={copyNewListName} onChange={function(e) { setCopyNewListName(e.target.value); }} autoFocus
                    placeholder="שם הרשימה החדשה" dir="rtl"
                    className="flex-1 border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-right focus:outline-none focus:border-blue-400" />
                  <button onClick={createListAndCopyItems} disabled={!copyNewListName.trim() || copyBusy}
                    className="bg-blue-600 text-white text-sm px-4 py-2.5 rounded-xl font-medium disabled:opacity-40 flex-shrink-0 flex items-center justify-center">
                    {copyBusy ? <Spinner /> : "צור והעתק"}
                  </button>
                </div>
              ) : (
                <button onClick={function() { setCopyNewListMode(true); }}
                  className="w-full text-sm text-blue-600 font-medium border border-blue-200 bg-blue-50 rounded-xl px-3 py-3 flex items-center justify-center gap-1.5">
                  <span>➕</span><span>רשימה חדשה</span>
                </button>
              )}
            </Modal>
          )}

          {/* Settings modal */}
          {showSettings && (
            <Modal onClose={() => setShowSettings(false)}>
              <div className="mb-4 pb-4 border-b border-gray-100">
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

              {/* ── Tabs: Contacts + user management share "משתמשים" — one
                  Modal, so a backdrop click always just closes Settings as a
                  whole instead of unpredictably landing on the home screen
                  depending on which sub-panel happened to be open. ── */}
              <div className="flex bg-gray-100 rounded-xl p-1 mb-4">
                {[["general", "כללי"], ["users", "פרופיל"]].map(function(tab) {
                  var key = tab[0], label = tab[1];
                  return (
                    <button key={key} onClick={function() { switchSettingsTab(key); }}
                      className={"flex-1 py-2 rounded-lg text-sm font-medium transition " + (settingsTab === key ? "bg-white shadow text-blue-600" : "text-gray-500")}>
                      {label}
                    </button>
                  );
                })}
              </div>

              {settingsTab === "general" && (<div>
              <button onClick={function() { setShowSettings(false); onCategories(); }} className="w-full text-right px-3 py-3 mb-2 text-sm text-gray-700 hover:bg-gray-50 rounded-xl flex items-center gap-3 border border-gray-100">
                <span className="text-lg w-7 text-center">🗺️</span><span>סדר קטגוריות בחנות</span>
              </button>
              {/* ── AI Provider ─────────────────────────────────────────────────── */}
              <div className="mt-1">
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
                <div className="px-3 py-2.5 flex items-center gap-3">
                  <span className="text-lg w-7 text-center">📝</span>
                  <span className="flex-1 text-sm text-gray-700">מילת מעבר בתפריטים</span>
                  <input value={notesSeparator} readOnly={!isAdmin} onChange={function(e) {
                    if (!isAdmin) return;
                    var val = e.target.value;
                    setNotesSeparator(val);
                    if (val.trim()) localStorage.setItem("buli_notes_separator", val.trim());
                  }} dir="rtl" maxLength={20}
                    className={"w-20 border rounded-lg px-2 py-1 text-sm text-center focus:outline-none " + (isAdmin ? "border-gray-200 focus:border-blue-400 text-gray-700" : "border-gray-100 bg-gray-50 text-gray-500")} />
                </div>
              </div>
              </div>)}

              {settingsTab === "users" && (<div>
              {/* ── Your profile — surfaced at the top instead of buried behind
                  the "ניהול משתמשים" toggle, since it's what most people open
                  this tab for. ── */}
              <div className="mb-4 bg-gray-50 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-gray-700 truncate">{user.email}</span>
                  <span className="text-xs font-bold text-gray-400 uppercase flex-shrink-0">{isRealAdmin ? "מנהל" : "משתמש"}</span>
                </div>
                <input key={"mynick:" + myNickname} type="text" defaultValue={myNickname}
                  placeholder="כינוי (יוצג ברשימת שיתוף)" dir="rtl"
                  onBlur={function(e) { var v = e.target.value.trim(); if (v !== myNickname) { setMyNickname(v); handleSaveNickname(user.email, v); } }}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:border-blue-400 mb-3" />
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">📝 תפריטים</span>
                    <button onClick={function() { setMyMenusEnabledPref(!myMenusEnabled); }}
                      className={"relative inline-flex h-6 w-11 items-center rounded-full transition-colors " + (myMenusEnabled ? "bg-blue-600" : "bg-gray-200")}>
                      <span className={"inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " + (myMenusEnabled ? "translate-x-6" : "translate-x-1")} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">✅ מטלות</span>
                    <button onClick={function() { setMyTasksEnabledPref(!myTasksEnabled); }}
                      className={"relative inline-flex h-6 w-11 items-center rounded-full transition-colors " + (myTasksEnabled ? "bg-blue-600" : "bg-gray-200")}>
                      <span className={"inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " + (myTasksEnabled ? "translate-x-6" : "translate-x-1")} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">⌨️ ביפ על שם פריט באנגלית</span>
                    <button onClick={function() { setMyKeyboardWarningPref(!myKeyboardWarning); }}
                      className={"relative inline-flex h-6 w-11 items-center rounded-full transition-colors " + (myKeyboardWarning ? "bg-blue-600" : "bg-gray-200")}>
                      <span className={"inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " + (myKeyboardWarning ? "translate-x-6" : "translate-x-1")} />
                    </button>
                  </div>
                  <div>
                    <div className="text-sm text-gray-700 mb-1">🔤 גודל טקסט</div>
                    <div className="flex bg-white rounded-xl border border-gray-200 p-1">
                      {[[100, "רגיל"], [115, "גדול"], [130, "גדול מאוד"]].map(function(opt) {
                        var val = opt[0], label = opt[1];
                        return (
                          <button key={val} onClick={function() { onSetFontScale(val); }}
                            className={"flex-1 py-1.5 rounded-lg text-xs font-medium transition " + (fontScale === val ? "bg-blue-600 text-white" : "text-gray-500")}>
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* ── Contacts (who gets auto-shared into new lists) ────────────────── */}
              <div className="mb-3">
                <button onClick={function() { setShowContacts(function(o) { if (!o) loadContacts(); return !o; }); }}
                  className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showContacts ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                  <div className="flex items-center gap-3">
                    <span className="text-lg w-7 text-center">👥</span>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-gray-700">אנשי קשר</div>
                      <div className="text-xs text-gray-400">משתמשים שאתה משתף איתם בקביעות</div>
                    </div>
                  </div>
                  <span className="text-gray-400 text-xs flex-shrink-0">{showContacts ? "▲ הסתר" : "▼ הצג"}</span>
                </button>
                {showContacts && (
                  <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                    {contactMembers === null ? (
                      <div className="flex justify-center py-6"><Spinner /></div>
                    ) : contactMembers.length === 0 ? (
                      <p className="text-xs text-gray-400 text-center py-4">אין עדיין משתמשים נוספים</p>
                    ) : (
                      <div className="space-y-1.5">
                        {contactMembers.map(function(m) {
                          return (
                            <div key={m.uid} className="bg-gray-50 rounded-xl px-3 py-2 flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-gray-700 truncate">{m.name}</div>
                                <div className="text-xs text-gray-400 truncate">{m.email}</div>
                              </div>
                              <div className="flex flex-col items-center gap-0.5 flex-shrink-0">
                                <button onClick={function() { toggleContactAlwaysShare(m.uid); }}
                                  className={"relative inline-flex h-6 w-11 items-center rounded-full transition-colors " + (m.alwaysShare ? "bg-blue-600" : "bg-gray-200")}>
                                  <span className={"inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " + (m.alwaysShare ? "translate-x-6" : "translate-x-1")} />
                                </button>
                                <span className="text-xs text-gray-400">תמיד</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ── Manage Users — admin-only now; a regular user's own info
                  already lives in the profile card above, so this section
                  (managing OTHER people's access) has nothing left to show
                  them. ── */}
              {isAdmin && (
              <div className="mt-3">
                <button onClick={function() { setShowUsers(function(o) { if (!o) loadAuthUsers(); return !o; }); }}
                  className={"w-full flex items-center justify-between px-3 py-3 rounded-xl border transition " + (showUsers ? "bg-white border-blue-200" : "bg-gray-50 border-transparent hover:bg-gray-100")}>
                  <div className="flex items-center gap-3">
                    <span className="text-lg w-7 text-center">🔑</span>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-gray-700">ניהול משתמשים</div>
                      <div className="text-xs text-gray-400">{isAdmin ? "מי יכול להשתמש בבולי" : "הפרטים שלך"}</div>
                    </div>
                  </div>
                  <span className="text-gray-400 text-xs flex-shrink-0">{showUsers ? "▲ הסתר" : "▼ הצג"}</span>
                </button>
                {showUsers && (
                  <div className="mt-2 bg-white border border-gray-100 rounded-2xl p-4">
                    {usersLoading ? (
                      <div className="flex justify-center py-6"><Spinner /></div>
                    ) : !isAdmin ? (
                      <div>
                        {selfUserInfo && (
                          <div className="bg-gray-50 rounded-xl px-3 py-2 mb-2">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-sm text-gray-700 truncate">{selfUserInfo.email}</span>
                              <span className="text-xs font-bold text-gray-400 uppercase flex-shrink-0">{selfUserInfo.role === "admin" ? "מנהל" : "משתמש"}</span>
                            </div>
                            <div className="text-xs text-gray-400 mb-1.5">
                              {selfUserInfo.lastLogin ? "התחבר לאחרונה: " + formatRefreshTime(selfUserInfo.lastLogin) : "מעולם לא התחבר"}
                            </div>
                            <div className="flex items-center gap-2">
                              <input key={"self:" + selfUserInfo.nickname} type="text" defaultValue={selfUserInfo.nickname || ""}
                                placeholder="כינוי (יוצג ברשימת שיתוף)" dir="rtl" disabled={userBusy}
                                onBlur={function(e) { var v = e.target.value.trim(); if (v !== (selfUserInfo.nickname || "")) handleSaveNickname(selfUserInfo.email, v); }}
                                className="flex-1 min-w-0 border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white focus:outline-none focus:border-blue-400" />
                            </div>
                          </div>
                        )}
                        {userMsg && <p className={"text-xs text-center mt-2 " + (userMsg.indexOf("✓") === 0 ? "text-green-500" : "text-red-500")}>{userMsg}</p>}
                      </div>
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
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                            <button onClick={function() { handleSetUserPref(ownerEmail, { menusEnabled: !ownerMenusEnabled }); }} disabled={userBusy} title="תפריטים"
                              className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (ownerMenusEnabled ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                              📝{ownerMenusEnabled ? "" : "🚫"}
                            </button>
                            <button onClick={function() { handleSetUserPref(ownerEmail, { tasksEnabled: !ownerTasksEnabled }); }} disabled={userBusy} title="מטלות"
                              className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (ownerTasksEnabled ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                              ✅{ownerTasksEnabled ? "" : "🚫"}
                            </button>
                            <button onClick={function() { handleSetUserPref(ownerEmail, { keyboardWarning: !ownerKeyboardWarning }); }} disabled={userBusy} title="ביפ על שם פריט באנגלית"
                              className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (ownerKeyboardWarning ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                              ⌨️{ownerKeyboardWarning ? "" : "🚫"}
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
                              </div>
                              <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                                <button onClick={function() { handleSetUserPref(u.email, { menusEnabled: !u.menusEnabled }); }} disabled={userBusy} title="תפריטים"
                                  className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (u.menusEnabled ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                                  📝{u.menusEnabled ? "" : "🚫"}
                                </button>
                                <button onClick={function() { handleSetUserPref(u.email, { tasksEnabled: !u.tasksEnabled }); }} disabled={userBusy} title="מטלות"
                                  className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (u.tasksEnabled ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                                  ✅{u.tasksEnabled ? "" : "🚫"}
                                </button>
                                <button onClick={function() { handleSetUserPref(u.email, { keyboardWarning: !u.keyboardWarning }); }} disabled={userBusy} title="ביפ על שם פריט באנגלית"
                                  className={"text-xs border rounded-full px-2 py-1 disabled:opacity-40 flex-shrink-0 " + (u.keyboardWarning ? "text-green-600 border-green-200 bg-green-50" : "text-gray-400 border-gray-200 bg-white")}>
                                  ⌨️{u.keyboardWarning ? "" : "🚫"}
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
              </div>)}

              {settingsTab === "general" && (<div>
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

              <div className="border-t border-gray-100 my-2" />
              <button onClick={function() { auth.signOut(); }} className="w-full text-right px-3 py-3 text-sm text-red-500 hover:bg-red-50 rounded-xl flex items-center gap-3">
                <span className="text-lg w-7 text-center">🚪</span><span>יציאה</span>
              </button>
              </div>)}

            </Modal>
          )}

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

          {/* A lightweight profile card — separate from ⚙️ Settings, which
              was a duplicate way to reach the exact same place. This one
              just identifies who's signed in and offers to sign out. */}
          {showProfileCard && (
            <Modal onClose={() => setShowProfileCard(false)}>
              <div className="flex flex-col items-center gap-3 pb-2">
                <div className="w-16 h-16 rounded-full overflow-hidden bg-gray-100 flex items-center justify-center flex-shrink-0">
                  {user.photoURL ? <img src={user.photoURL} alt="" className="w-full h-full object-cover" /> : <span className="text-3xl">👤</span>}
                </div>
                <div className="text-center">
                  <div className="font-bold text-gray-800">{user.displayName}</div>
                  <div className="text-xs text-gray-400">{user.email}</div>
                </div>
                <button onClick={() => auth.signOut()}
                  className="w-full mt-2 py-3 rounded-2xl border border-red-200 text-red-500 font-medium">
                  🚪 התנתק
                </button>
              </div>
            </Modal>
          )}

          {/* Install guide — iOS/Safari gets exact steps; every other browser
              that hasn't (yet) fired the native beforeinstallprompt gets a
              generic pointer, so the option is still useful instead of a dead end. */}
          {showInstallGuide && (
            <Modal onClose={() => setShowInstallGuide(false)}>
              <h3 className="text-xl font-bold text-center mb-1">הוסף למסך הבית 📲</h3>
              <p className="text-sm text-gray-400 text-center mb-5">
                {_isIOS ? "בצע את הצעדים הבאים בספארי" : "בצע את הצעדים הבאים בדפדפן"}
              </p>
              {_isIOS ? (
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
              ) : (
                <div className="space-y-3 mb-5">
                  <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3">
                    <span className="text-2xl w-8 text-center flex-shrink-0">1</span>
                    <div>
                      <p className="font-semibold text-gray-800 text-sm">פתח את תפריט הדפדפן</p>
                      <p className="text-xs text-gray-400">שלוש הנקודות ⋮ למעלה, או תפריט ההגדרות</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3">
                    <span className="text-2xl w-8 text-center flex-shrink-0">2</span>
                    <div>
                      <p className="font-semibold text-gray-800 text-sm">חפש</p>
                      <p className="text-xs text-gray-400">"התקן אפליקציה" או "הוסף למסך הבית"</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 bg-gray-50 rounded-2xl px-4 py-3">
                    <span className="text-2xl w-8 text-center flex-shrink-0">3</span>
                    <div>
                      <p className="font-semibold text-gray-800 text-sm">אשר את ההתקנה</p>
                      <p className="text-xs text-gray-400">האפליקציה תופיע במסך הבית</p>
                    </div>
                  </div>
                </div>
              )}
              <button onClick={() => setShowInstallGuide(false)} className="w-full bg-blue-600 text-white py-4 rounded-2xl font-semibold">הבנתי</button>
            </Modal>
          )}
        </div>
      );
    }

    function ListCard({ list, userId, onOpen, menuOpen, onMenuToggle, onMarkDone, onRestore, onTogglePrivacy, onRename, onDuplicate, onCopyItems, onDelete, isDone, onEdit }) {
      const isOwner = list.ownerId === userId;
      var dateStr = list.dinnerDate
        ? formatDinnerDate(list.dinnerDate)
        : (list.createdAt ? (function(){ var d = new Date(list.createdAt); return d.getDate()+"/"+(d.getMonth()+1)+"/"+d.getFullYear(); })() : "");

      // Cards near the bottom of the screen had this menu open downward and
      // run off-screen. Flipping upward alone wasn't enough either — the
      // list of cards sits inside its own scrolling container, and a
      // position:absolute menu anchored inside it gets silently clipped by
      // that container's own top edge (above the fixed header) no matter
      // how much room the viewport itself actually has above the button —
      // that clipping, not a wrong height estimate, was hiding the first
      // few rows with no way to scroll to them.
      //
      // Fixed positioning in real viewport pixel coordinates escapes that
      // ancestor entirely, so the menu can only ever be bounded by the
      // actual screen edges — which the maxHeight/overflow-y-auto below
      // already handle safely.
      const menuBtnRef = React.useRef(null);
      const [menuLayout, setMenuLayout] = React.useState(null);
      const handleMenuToggle = function(e) {
        if (!menuOpen && menuBtnRef.current) {
          var rect = menuBtnRef.current.getBoundingClientRect();
          var spaceBelow = window.innerHeight - rect.bottom;
          var spaceAbove = rect.top;
          var upward = spaceBelow < 320 && spaceAbove > spaceBelow;
          var available = (upward ? spaceAbove : spaceBelow) - 16;
          setMenuLayout({
            openUpward: upward,
            maxHeight: Math.max(140, available),
            left: Math.max(8, rect.right - 180),
            top: upward ? null : rect.bottom + 4,
            bottom: upward ? (window.innerHeight - rect.top + 4) : null,
          });
        }
        onMenuToggle(e);
      };

      return (
        <div className="relative">
          <div className="w-full bg-white rounded-2xl p-4 flex items-center gap-3 shadow-sm border border-gray-100 hover:border-blue-200 transition cursor-pointer" onClick={onOpen}>
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
            <button ref={menuBtnRef} onClick={handleMenuToggle} className="text-gray-400 text-xl px-1 hover:text-gray-600 flex-shrink-0">⋮</button>
          </div>
          {menuOpen && menuLayout && (
            <div className="fixed bg-white rounded-xl shadow-xl border border-gray-100 z-20 overflow-y-auto min-w-44"
              style={{
                left: menuLayout.left,
                top: menuLayout.top != null ? menuLayout.top : undefined,
                bottom: menuLayout.bottom != null ? menuLayout.bottom : undefined,
                maxHeight: menuLayout.maxHeight + "px",
              }}
              onClick={e => e.stopPropagation()}>
              {isOwner && onRename && (
                <button onClick={onRename} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>✏️</span><span>שנה שם</span>
                </button>
              )}
              {onDuplicate && (
                <button onClick={onDuplicate} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>📋</span><span>שכפל רשימה</span>
                </button>
              )}
              {onCopyItems && (
                <button onClick={onCopyItems} className="w-full text-right px-4 py-3 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-2">
                  <span>📤</span><span>העתק פריטים לרשימה אחרת</span>
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
            <h2 className="font-bold text-gray-600 text-sm mb-1 text-right">סידור בחנות 🏪</h2>
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
              <input key={"profname:" + editProfile.id} defaultValue={editProfile.name}
                onBlur={function(e) {
                  var v = e.target.value.trim();
                  if (!v || v === editProfile.name) { e.target.value = editProfile.name; return; }
                  setEditProfile(function(prev) { return prev ? Object.assign({}, prev, { name: v }) : prev; });
                  setProfiles(function(prev) { return prev.map(function(p) { return p.id === editProfile.id ? Object.assign({}, p, { name: v }) : p; }); });
                  db.ref("globalProfiles/" + editProfile.id + "/name").set(v);
                  showToast("השם עודכן");
                }}
                className="w-full text-lg font-bold text-center mb-1 border-b border-transparent focus:border-blue-300 focus:outline-none pb-1" />
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
    function ListScreen({ user, listId, onBack, onMenu, onHome, onAdd, showToast }) {
      const [categories, setCategories] = useState([]);
      const [list,       setList]       = useState(null);
      const [items,      setItems]      = useState([]);
      const [loading,    setLoading]    = useState(true);
      const [loadError,  setLoadError]  = useState(null);
      const [profiles,         setProfiles]         = useState([]);
      // Category order follows whichever store-layout profile (see
      // globalProfiles) is currently picked — "default" until the user
      // chooses one manually via showProfilePicker.
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
      const [removingShareUid, setRemovingShareUid] = useState(null);
      const [filterStatus, setFilterStatus] = useState(function() { return localStorage.getItem("buli_filter_status") || "all"; });
      const [filterPerson, setFilterPerson] = useState(function() { return localStorage.getItem("buli_filter_person") || "all"; });
      const [showFilters, setShowFilters] = useState(false);
      const [showHeaderMenu, setShowHeaderMenu] = useState(false);
      const [showCategorizeChoice, setShowCategorizeChoice] = useState(false);
      const [categorizing, setCategorizing] = useState(false);
      const [keyboardWarningEnabled, setKeyboardWarningEnabled] = useState(true);
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

        db.ref("users/" + user.uid + "/keyboardWarning").once("value").then(function(snap) {
          setKeyboardWarningEnabled(snap.val() !== false);
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

      // Reuses the same parseItems AI call the free-text add flow uses,
      // just fed the existing item names instead of freshly typed text.
      // Matches results back onto items by name (not by index/order —
      // the AI isn't guaranteed to preserve order or count) so a
      // partial/garbled response only skips items instead of
      // mis-assigning a category to the wrong item.
      const runAutoCategorize = (scopeAll) => {
        const targets = items.filter(function(i) { return scopeAll || (i.category || "שונות") === "שונות"; });
        if (!targets.length) {
          showToast(scopeAll ? "אין פריטים ברשימה" : "כל הפריטים כבר מסווגים");
          return;
        }
        setCategorizing(true);
        db.ref("users/" + user.uid + "/ai").once("value").then(function(snap) {
          const ai = snap.val();
          if (!ai || !ai.provider) {
            showToast("יש להגדיר ספק AI תחילה — הגדרות ← הגדרות AI");
            setCategorizing(false);
            return;
          }
          const cats = categories.length > 0 ? categories : DEFAULT_CATEGORIES;
          const text = targets.map(function(i) { return i.name; }).join("\n");
          parseWithAI(text, cats, ai).then(function(aiItems) {
            const catEmojis = {}, validCats = new Set();
            cats.forEach(function(c) { catEmojis[c.label] = c.emoji; validCats.add(c.label); });
            const byName = {};
            targets.forEach(function(item) {
              const key = (item.name || "").trim().toLowerCase();
              (byName[key] = byName[key] || []).push(item);
            });
            const updates = {};
            let count = 0;
            (aiItems || []).forEach(function(res) {
              const key = ((res.name || res.item || "").trim()).toLowerCase();
              const bucket = byName[key];
              if (!bucket || !bucket.length) return;
              const item = bucket.shift();
              const aiCat = (res.category || "").trim();
              if (!validCats.has(aiCat) || aiCat === "שונות") return;
              updates["items/" + listId + "/" + item.id + "/category"] = aiCat;
              updates["items/" + listId + "/" + item.id + "/categoryEmoji"] = catEmojis[aiCat] || "🛍️";
              count++;
            });
            if (!count) {
              showToast("לא נמצאו קטגוריות מתאימות");
              setCategorizing(false);
              return;
            }
            db.ref().update(updates).then(function() {
              showToast(count + " פריטים סווגו בהצלחה");
              setCategorizing(false);
            }, function(err) {
              showToast("שגיאה בשמירה: " + (err && err.message));
              setCategorizing(false);
            });
          }).catch(function(e) {
            showToast(e.message || "שגיאה בחיבור ל-AI");
            setCategorizing(false);
          });
        });
      };

      const saveEdit = (updated) => {
        setItems(function(prev) { return prev.map(function(i) { return i.id === updated.id ? Object.assign({}, i, updated) : i; }); });
        setEditItem(null);
        db.ref("items/" + listId + "/" + updated.id).update({
          name: updated.name, quantity: updated.quantity !== "" && updated.quantity != null ? Number(updated.quantity) || 1 : null,
          unit: updated.unit, category: updated.category, note: updated.note || ""
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



      const shareWithContacts = () => {
        if (!selectedContacts.length && !shareEmail.trim()) return;
        // Own email shares nothing (you already have access) — if that's the
        // only thing submitted, stop before the generic "שותף!" success
        // toast can fire and paper over the fact that nothing happened.
        var ownEmail = !!shareEmail.trim() && shareEmail.trim().toLowerCase() === (user.email || "").toLowerCase();
        if (!selectedContacts.length && ownEmail) {
          showToast("זה כבר האימייל שלך — הרשימה כבר שלך");
          return;
        }
        var emailToShare = shareEmail.trim() && !ownEmail;
        setSharing(true);
        var total = selectedContacts.length + (emailToShare ? 1 : 0);
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
        if (emailToShare) {
          db.ref("usersByEmail/" + encodeEmail(shareEmail.trim().toLowerCase())).once("value").then(function(snap) {
            if (!snap.exists()) { showToast("אימייל לא נמצא"); done(); return; }
            var uid = snap.val();
            if (uid === user.uid) { showToast("זה כבר האימייל שלך — הרשימה כבר שלך"); done(); return; }
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

      const removeShare = (uid) => {
        setRemovingShareUid(uid);
        db.ref().update({ ["lists/" + listId + "/sharedWith/" + uid]: null, ["listsByUser/" + uid + "/" + listId]: null }).then(function() {
          setList(function(prev) {
            if (!prev) return prev;
            var nextShared = Object.assign({}, prev.sharedWith);
            delete nextShared[uid];
            return Object.assign({}, prev, { sharedWith: nextShared });
          });
          setRemovingShareUid(null);
          showToast("ההרשאה הוסרה");
        }, function(err) { setRemovingShareUid(null); showToast("שגיאה: " + (err && err.message || "?")); });
      };
      const isOwnEmail = !!shareEmail.trim() && shareEmail.trim().toLowerCase() === (user.email || "").toLowerCase();

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
      const clearAllFilters   = function() { applyStatusFilter("all"); applyPersonFilter("all"); };

      const filteredItems = items.filter(function(item) {
        if (filterPerson === "mine"   && item.addedBy !== user.uid) return false;
        if (filterPerson === "others" && item.addedBy === user.uid) return false;
        if (filterStatus === "done"    && !item.done) return false;
        if (filterStatus === "pending" &&  item.done) return false;
        // Picking a shop here (via "סידور לפי חנות") only reorders categories
        // to match its aisle layout — it must never also hide items, that's
        // a different, separate concern from ordering.
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
      const renderGroup = (arr) => {
        if (!isTasks && sortBy === "name") {
          return (
            <div className="space-y-2">
              {[...arr].sort((a,b) => (a.name||"").localeCompare(b.name||"","he")).map(item =>
                <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={false} currentUserId={user.uid} />
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
              {group.items.map(item => <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={false} currentUserId={user.uid} />)}
            </div>
          </div>
        ));
      };

      const doneCount  = filteredItems.filter(i => i.done).length;
      const isFiltered = filterStatus !== "all" || filterPerson !== "all";

      return (
        <div className="bg-gray-50 flex flex-col print-list-root" style={{height:"100dvh"}}>
          <div className="bg-blue-600 text-white px-4 pt-6 pb-3 flex-shrink-0 no-print">
            {/* One line for nav+title+overflow (icon-only back button now
                that print/share/settings all live in ☰, so there's room),
                a single icon toolbar below for everything list-related. */}
            <div className="flex items-center gap-2" dir="ltr">
              <button onClick={onBack} title="חזרה"
                className="flex items-center justify-center text-white bg-white/20 w-8 h-8 rounded-full flex-shrink-0">
                <span className="text-lg leading-none">‹</span>
              </button>
              <h1 className="flex-1 min-w-0 text-lg font-bold truncate text-right">{list.name}</h1>
              <button onClick={function() { setShowHeaderMenu(true); }} className="text-white text-lg w-8 h-8 flex items-center justify-center bg-white/20 rounded-full flex-shrink-0">☰</button>
            </div>
            {/* Notes lists skip the toolbar entirely below, so the counter
                has nowhere else to live — kept here only for that case. */}
            {isNotes && (
              <div className="flex items-center justify-end mt-2" dir="ltr">
                <span className="text-white/50 text-xs">{notesSorted.filter(i=>i.done).length + "/" + notesSorted.length}</span>
              </div>
            )}
          </div>

          {showHeaderMenu && (
            <Modal onClose={function() { setShowHeaderMenu(false); }}>
              <h3 className="text-lg font-bold text-center mb-4">פעולות</h3>
              <div className="space-y-2">
                {!isNotes && !isTasks && (
                  <button onClick={function() { setShowHeaderMenu(false); window.print(); }}
                    className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 hover:bg-gray-100">
                    <span className="text-lg">🖨️</span><span className="text-sm font-medium text-gray-700">הדפס / ייצוא ל-PDF</span>
                  </button>
                )}
                {isOwner && !list.isPrivate && !isNotes && (
                  <button onClick={function() { setShowHeaderMenu(false); openShare(); }}
                    className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 hover:bg-gray-100">
                    <span className="text-lg">🔗</span><span className="text-sm font-medium text-gray-700">שתף רשימה</span>
                  </button>
                )}
                {!isNotes && doneCount > 0 && canEditAll && !isFiltered && (
                  <button onClick={function() { setShowHeaderMenu(false); clearDone(); }}
                    className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 hover:bg-gray-100">
                    <span className="text-lg">🗑️</span><span className="text-sm font-medium text-gray-700">{isTasks ? "מחק מטלות שהושלמו" : "מחק פריטים מהסל"}</span>
                  </button>
                )}
                {!isNotes && !isTasks && canEditAll && (
                  <button onClick={function() { setShowHeaderMenu(false); setShowCategorizeChoice(true); }}
                    className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 hover:bg-gray-100">
                    <span className="text-lg">✨</span><span className="text-sm font-medium text-gray-700">השלם קטגוריות</span>
                  </button>
                )}
                <button onClick={function() { setShowHeaderMenu(false); onMenu(); }}
                  className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 hover:bg-gray-100">
                  <span className="text-lg">⚙️</span><span className="text-sm font-medium text-gray-700">הגדרות</span>
                </button>
              </div>
            </Modal>
          )}

          {showCategorizeChoice && (
            <Modal onClose={function() { setShowCategorizeChoice(false); }}>
              <h3 className="text-lg font-bold text-center mb-2">השלם קטגוריות</h3>
              <p className="text-center text-gray-500 text-sm mb-5">אילו פריטים לסווג באמצעות AI?</p>
              <div className="space-y-2">
                <button onClick={function() { setShowCategorizeChoice(false); runAutoCategorize(false); }}
                  className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-blue-50 hover:bg-blue-100 border border-blue-200">
                  <span className="text-lg">🛍️</span>
                  <span className="text-sm font-medium text-gray-700">רק פריטים ב"שונות"</span>
                </button>
                <button onClick={function() { setShowCategorizeChoice(false); runAutoCategorize(true); }}
                  className="w-full text-right flex items-center gap-3 px-4 py-3 rounded-xl bg-gray-50 hover:bg-gray-100">
                  <span className="text-lg">📋</span>
                  <span className="text-sm font-medium text-gray-700">כל הפריטים ברשימה</span>
                </button>
              </div>
              <button onClick={function() { setShowCategorizeChoice(false); }} className="w-full mt-3 py-2.5 text-gray-500 text-sm">ביטול</button>
            </Modal>
          )}

          {categorizing && (
            <Modal disableClose={true}>
              <div className="flex flex-col items-center gap-3 py-4">
                <Spinner />
                <p className="text-gray-600 text-sm">מסווג פריטים באמצעות AI...</p>
              </div>
            </Modal>
          )}

          {!isNotes && (
            <div className="bg-white border-b border-gray-100 px-4 py-2 flex-shrink-0 no-print">
              <div className="flex items-center gap-2">
                {/* Right zone (RTL start): sort toggle. */}
                <div className="flex items-center gap-1.5 flex-shrink-0 min-w-0">
                  <div className="flex bg-gray-100 rounded-full p-0.5 flex-shrink-0">
                    <button onClick={function() { setSortBy("name"); }}
                      className={"text-xs px-3 py-1 rounded-full transition " + (sortBy==="name" ? "bg-white text-blue-600 font-semibold shadow-sm" : "text-gray-500")}>שם</button>
                    <button onClick={function() {
                      setSortBy("category");
                      if (profiles.length > 0) setShowProfilePicker(true);
                    }} className={"text-xs px-3 py-1 rounded-full transition flex items-center gap-1 " + (sortBy==="category" ? "bg-white text-blue-600 font-semibold shadow-sm" : "text-gray-500")}>
                      {sortBy === "category" && activeProfile !== "default"
                        ? ((profiles.find(function(p) { return p.id === activeProfile; }) || {}).name || "קטגוריה")
                        : "קטגוריה"}
                      {profiles.length > 0 && <span style={{fontSize:"9px"}}>▾</span>}
                    </button>
                  </div>
                </div>
                {/* Left zone (RTL end): counter + filters. */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-xs text-gray-400 whitespace-nowrap">
                    {isFiltered ? filteredItems.length + "/" + items.length : doneCount + "/" + items.length}
                  </span>
                  <button onClick={function() { setShowFilters(function(p) { return !p; }); }} title="מסננים"
                    className={"w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border " + (showFilters ? "bg-blue-50 border-blue-200 text-blue-600" : "bg-gray-50 border-gray-200 text-gray-500")}>
                    <span className="text-sm">🎚️</span>
                  </button>
                  {isFiltered && (
                    <button onClick={clearAllFilters} className="text-gray-400 hover:text-gray-600 text-xs flex-shrink-0" title="נקה פילטרים">✕</button>
                  )}
                </div>
              </div>
              {showFilters && (
                <div className="mt-2 bg-gray-50 border border-gray-200 rounded-2xl p-2.5 space-y-2.5">
                  <div className="flex justify-end">
                    <button onClick={function() { setShowFilters(false); }} className="text-gray-400 hover:text-gray-600 text-sm w-6 h-6 flex items-center justify-center flex-shrink-0" title="סגור מסננים">✕</button>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs mb-1">סטטוס</div>
                    <div className="flex bg-white rounded-full p-0.5 gap-0.5 w-fit border border-gray-200">
                      {[["all","הכל"],["pending","○ פתוח"],["done","✓ " + (isTasks ? "הושלם" : "בסל")]].map(function(entry) {
                        var v = entry[0], l = entry[1];
                        return (
                          <button key={v} onClick={function() { applyStatusFilter(v); }}
                            className={"text-xs px-2 py-1 rounded-full transition whitespace-nowrap " + (filterStatus===v ? "bg-blue-600 text-white font-semibold" : "text-gray-500")}>
                            {l}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-400 text-xs mb-1">מי הוסיף</div>
                    <div className="flex bg-white rounded-full p-0.5 gap-0.5 w-fit border border-gray-200">
                      {[["all","כולם"],["mine","שלי"],["others","אחרים"]].map(function(entry) {
                        var v = entry[0], l = entry[1];
                        return (
                          <button key={v} onClick={function() { applyPersonFilter(v); }}
                            className={"text-xs px-2.5 py-1 rounded-full transition " + (filterPerson===v ? "bg-blue-600 text-white font-semibold" : "text-gray-500")}>
                            {l}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {/* Reorders categories to match a store's aisle layout
                      (profiles = globalProfiles, the shared "סידור בחנות"
                      list), same mechanism as the toolbar's שם/קטגוריה
                      picker, just reachable from here too. */}
                  {!isTasks && profiles.length > 0 && (
                    <div>
                      <div className="text-gray-400 text-xs mb-1">סידור לפי חנות</div>
                      <div className="flex flex-wrap gap-1">
                        {[{ id: "default", name: "ברירת מחדל" }].concat(profiles).map(function(p) {
                          return (
                            <button key={p.id} onClick={function() {
                              setSortBy("category");
                              setActiveProfile(p.id);
                              localStorage.setItem("buli_profile", p.id);
                            }} className={"text-xs px-2.5 py-1 rounded-full transition whitespace-nowrap border " + (activeProfile===p.id ? "bg-blue-600 text-white border-blue-600 font-semibold" : "bg-white text-gray-500 border-gray-200")}>
                              {p.name}
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

          {!isNotes && !isTasks && (
            <div className="hidden print-only px-4 pt-4 pb-2">
              <h1 className="text-xl font-bold text-right">{list.name}</h1>
              <p className="text-xs text-gray-500 text-right mt-1">{new Date().toLocaleDateString("he-IL")}</p>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-4 pb-28 print-items-area">
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
            ) : isTasks ? (
              <>
                {renderGroup(notDone)}
                {done.length > 0 && (
                  <div className="mb-5 mt-2">
                    <div className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1">
                      <span>✅</span><span>הושלם</span>
                    </div>
                    <div className="space-y-2">
                      {done.map(item => <ItemRow key={item.id} item={item} canEdit={canEditItem(item)} onToggle={toggle} onDelete={remove} onEdit={() => editFn(item)} onUpdateNote={updateNote} isTasks={true} currentUserId={user.uid} />)}
                    </div>
                  </div>
                )}
              </>
            ) : (
              // Marking an item "in the basket" no longer moves it to a
              // separate section at the bottom — it stays exactly where it
              // was in the list, just visually marked (line-through, filled
              // basket icon), so the list doesn't reshuffle under the user's
              // finger while shopping.
              renderGroup(filteredItems)
            )}
          </div>

          {canAddItems && (
            <button onClick={() => onAdd(list.type, list.name)}
              className="fixed bottom-5 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-5 py-3 rounded-2xl shadow-xl font-semibold text-sm flex items-center gap-1.5 no-print">
              <span className="text-base font-light">+</span> {isTasks ? "הוסף מטלה" : isNotes ? "הוסף מנות" : "הוסף פריטים"}
            </button>
          )}

          {editItem && <ItemDialog mode="edit" item={editItem} categories={categories}
            keyboardWarningEnabled={keyboardWarningEnabled}
            onSave={saveEdit} onClose={() => setEditItem(null)} showToast={showToast} />}
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


          {showShare && (
            <Modal onClose={() => setShowShare(false)}>
              <h3 className="text-lg font-bold text-center mb-1">שתף רשימה</h3>
              <p className="text-xs text-gray-400 text-center mb-4">
                השיתוף נותן גישה בתוך בולי — לא נשלח מייל. האדם צריך כבר להיות רשום לבולי עם המייל הזה, ואז הרשימה תופיע אצלו בפעם הבאה שהוא פותח את האפליקציה.
              </p>
              {list.sharedWith && Object.keys(list.sharedWith).length > 0 && (
                <div className="mb-4">
                  <p className="text-xs text-gray-400 mb-2 text-right">משותפת עם</p>
                  <div className="space-y-2">
                    {Object.entries(list.sharedWith).map(function(entry) {
                      var uid = entry[0], role = entry[1];
                      var c = contacts.find(function(x) { return x.id === uid; });
                      var roleLabel = role === "edit" ? "עריכה מלאה" : role === "own" ? "שלי בלבד" : "צפייה";
                      return (
                        <div key={uid} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50">
                          <div className="flex-1 min-w-0 text-right">
                            <div className="text-sm font-medium text-gray-800 truncate">{c ? c.name : uid}</div>
                            <div className="text-xs text-gray-400 truncate">{[c && c.email, roleLabel].filter(Boolean).join(" · ")}</div>
                          </div>
                          <button onClick={function() { removeShare(uid); }} disabled={removingShareUid === uid}
                            className="text-red-400 hover:text-red-600 text-xs border border-red-200 rounded-full px-2.5 py-1 disabled:opacity-40 flex-shrink-0">
                            {removingShareUid === uid ? <Spinner /> : "הסר"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400 mb-1" />
              {isOwnEmail && (
                <p className="text-xs text-orange-500 text-right mb-2">זה כבר האימייל שלך — הרשימה כבר שלך, אין צורך לשתף</p>
              )}
              <p className="text-xs text-gray-400 mb-2 text-right mt-2">הרשאות</p>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[["edit","✏️ מלאה"],["own","👤 שלי בלבד"],["view","👁️ צפייה"]].map(([v,l]) => (
                  <button key={v} onClick={() => setShareRole(v)}
                    className={`py-3 rounded-xl text-xs font-medium border transition ${shareRole===v?"bg-blue-600 text-white border-blue-600":"bg-white text-gray-600 border-gray-200"}`}>{l}</button>
                ))}
              </div>
              <button onClick={shareWithContacts} disabled={(!selectedContacts.length && !shareEmail.trim()) || (!selectedContacts.length && isOwnEmail) || sharing}
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

    function ItemRow({ item, canEdit, onToggle, onDelete, onEdit, onUpdateNote, isTasks, currentUserId }) {
      const [editingNote, setEditingNote] = useState(false);
      const [noteVal,     setNoteVal]     = useState(item.note || "");

      const openNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(true); };
      const saveNote = (e) => { e.stopPropagation(); onUpdateNote(item.id, noteVal.trim()); setEditingNote(false); };
      const cancelNote = (e) => { e.stopPropagation(); setNoteVal(item.note || ""); setEditingNote(false); };

      // Count and unit shown separately: "(2)" for how many, plus the unit
      // label only when it's not the generic "יחידות" default (a weight/
      // volume unit like "500 גרם" is real info; "יחידות" just repeats
      // what buying by the piece already implies).
      const qtyCount = (!isTasks && item.quantity && item.quantity !== 1) ? "(" + item.quantity + ")" : "";
      const qtyUnit = (!isTasks && item.unit && item.unit !== "יחידות") ? item.unit : "";
      const qty = [qtyCount, qtyUnit].filter(Boolean).join(" ");
      const dateStr = isTasks ? formatDueDate(item.dueDate) : "";

      return (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className={`flex items-center gap-2 px-3 py-2.5 ${isTasks && canEdit ? "cursor-pointer active:bg-gray-50" : ""}`}
               onClick={isTasks && canEdit ? onEdit : undefined}>
            {isTasks && (
              <span onClick={function(e){e.stopPropagation();}}>
                <Checkbox checked={!!item.done} onChange={() => onToggle(item)} />
              </span>
            )}
            <div className="flex-1 min-w-0">
              <span onClick={!isTasks && canEdit ? function(e) { e.stopPropagation(); onEdit(); } : undefined}
                className={`font-medium text-sm ${item.done ? "line-through text-gray-400" : (!isTasks && item.optional) ? ("text-gray-400" + (canEdit ? " underline decoration-gray-300 underline-offset-2" : "")) : (!isTasks && canEdit ? "text-blue-600 underline decoration-blue-200 underline-offset-2" : "text-gray-800")} ${!isTasks && canEdit ? "cursor-pointer" : ""}`}>
                {item.name}
              </span>
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
            </div>
            {!isTasks && (
              <span onClick={function(e){e.stopPropagation();}}>
                <BasketToggle checked={!!item.done} onChange={() => onToggle(item)} />
              </span>
            )}
            {!isTasks && qty ? (
              <span className="text-xs font-medium text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full flex-shrink-0 min-w-12 text-center">{qty}</span>
            ) : !isTasks ? <span className="w-12" /> : null}
            {!isTasks && canEdit && <button onClick={function(e){e.stopPropagation(); onDelete(item.id);}} className="text-red-400 hover:text-red-600 flex-shrink-0 text-lg leading-none px-0.5 font-bold">✕</button>}
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

    // ── ITEM DIALOG (add + edit, one component) ──────────────────────────────────
    // The only real differences between add and edit are where the starting
    // data comes from and what the primary button does, so they share one
    // implementation instead of two parallel dialogs that drift apart.
    // Short two-tone beep — no audio file needed, just a Web Audio
    // oscillator — used to flag a name that was probably typed on the
    // wrong keyboard layout (Hebrew intended, English letters landed).
    function playKeyboardWarningBeep() {
      try {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        var ctx = new Ctx();
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 740;
        gain.gain.setValueAtTime(0.001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.2);
      } catch (e) {}
    }

    function ItemDialog({ mode, item, categories, keyboardWarningEnabled, onSave, onInsert, onClose, showToast }) {
      const isEdit = mode === "edit";
      const blankDraft = function() {
        // Look up "other" by id, not a hardcoded label — an admin can
        // rename the category's Hebrew text from Settings, and a new item
        // should still default into whichever category is actually the
        // catch-all, not a stale literal that no longer matches anything.
        var activeCats = (categories && categories.length > 0) ? categories : DEFAULT_CATEGORIES;
        var other = activeCats.find(function(c) { return c.id === "other"; }) || activeCats[activeCats.length - 1];
        return { name: "", category: other.label, categoryEmoji: other.emoji, quantity: 1, unit: "יחידות", note: "" };
      };
      const [draft, setDraft] = useState(function() {
        if (!isEdit || !item) return blankDraft();
        return Object.assign({}, blankDraft(), item);
      });
      const [saving, setSaving] = useState(false);
      // Beeps once per continuous run of "starts with a Latin letter" typing
      // (a classic sign of typing Hebrew on an English keyboard layout) —
      // resets as soon as the name no longer starts that way, so fixing it
      // or genuinely typing an English-first name (rare) doesn't keep beeping.
      const [nameWarned, setNameWarned] = useState(false);
      const checkNameLanguage = function(v) {
        if (!keyboardWarningEnabled) return;
        var startsLatin = /^[A-Za-z]/.test(v.trim());
        if (startsLatin && v.trim().length >= 2) {
          if (!nameWarned) { playKeyboardWarningBeep(); setNameWarned(true); }
        } else if (nameWarned) {
          setNameWarned(false);
        }
      };

      // In add mode there are two ways to save: stay open and reset for the
      // next item ("שמור והמשך", the default for rapid one-at-a-time entry)
      // or save this one and close ("שמור וצא"). `quitAfter` picks which.
      const [savingQuit, setSavingQuit] = useState(false);
      const doSave = function(quitAfter) {
        setSaving(true);
        setSavingQuit(!!quitAfter);
        if (isEdit) {
          onSave(draft);
        } else {
          onInsert(draft, function() {
            setSaving(false);
            if (quitAfter) { onClose(); return; }
            setDraft(blankDraft());
          });
        }
      };

      const handlePrimary = function(quitAfter) {
        if (!draft.name.trim() || saving) return;
        doSave(quitAfter);
      };
      // "סיים" is one smart action, not a plain cancel: if a name was
      // actually typed, it saves-and-closes just like handlePrimary(true);
      // if the field is still empty, there's nothing to save, so it just
      // closes — the user shouldn't have to notice which case they're in.
      const handleFinish = function() {
        if (saving) return;
        if (!draft.name.trim()) { onClose(); return; }
        handlePrimary(true);
      };

      return (
        <Modal onClose={onClose} disableClose={!isEdit} footer={
          isEdit ? (
            <button onClick={handlePrimary} disabled={!draft.name.trim() || saving}
              className="w-full bg-blue-600 text-white py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
              {saving ? <Spinner /> : "שמור שינויים"}
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={function() { handlePrimary(false); }} disabled={!draft.name.trim() || saving}
                className="flex-1 bg-blue-600 text-white py-3 rounded-2xl font-semibold text-sm disabled:opacity-40">
                {saving && !savingQuit ? <Spinner /> : "+ הוסף"}
              </button>
              <button onClick={handleFinish} disabled={saving}
                className="flex-1 py-3 rounded-2xl border border-gray-200 text-gray-600 font-medium text-sm disabled:opacity-40">
                {saving && savingQuit ? <Spinner /> : "סיים"}
              </button>
            </div>
          )
        }>
          <h3 className="text-lg font-bold text-center mb-1">{isEdit ? "עריכת פריט" : "הוספת פריט"}</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">שם</label>
              <input value={draft.name} autoFocus={!isEdit} onChange={function(e) { setDraft(Object.assign({}, draft, { name: e.target.value })); checkNameLanguage(e.target.value); }}
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-500 block mb-1">כמות</label>
                {/* +/- buttons instead of relying on the native number input's
                    tiny spinner arrows (or opening the keyboard) just to bump
                    a quantity by 1 — the single most common edit here. */}
                <div className="flex items-center gap-1">
                  <button type="button"
                    onClick={function() { setDraft(Object.assign({}, draft, { quantity: Math.max(0.1, Math.round(((parseFloat(draft.quantity) || 1) - 1) * 10) / 10) })); }}
                    className="w-10 h-11 rounded-xl bg-gray-100 text-gray-600 text-xl font-bold flex items-center justify-center active:bg-gray-200 flex-shrink-0">−</button>
                  <input type="number" min="0.1" step="0.1" value={draft.quantity} onChange={function(e) { setDraft(Object.assign({}, draft, { quantity: e.target.value })); }}
                    className="w-full min-w-0 border border-gray-200 rounded-xl px-1 py-3 text-center focus:outline-none focus:border-blue-400" />
                  <button type="button"
                    onClick={function() { setDraft(Object.assign({}, draft, { quantity: Math.round(((parseFloat(draft.quantity) || 0) + 1) * 10) / 10 })); }}
                    className="w-10 h-11 rounded-xl bg-blue-50 text-blue-600 text-xl font-bold flex items-center justify-center active:bg-blue-100 flex-shrink-0">+</button>
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">יחידה</label>
                <select value={draft.unit} onChange={function(e) { setDraft(Object.assign({}, draft, { unit: e.target.value })); }}
                  className="w-full border border-gray-200 rounded-xl px-3 py-3 text-right focus:outline-none focus:border-blue-400 bg-white">
                  {UNITS.map(function(u) { return <option key={u} value={u}>{u}</option>; })}
                </select>
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">קטגוריה</label>
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                {(categories && categories.length > 0 ? categories : DEFAULT_CATEGORIES).map(function(cat) {
                  var isSelected = draft.category === cat.label;
                  return (
                    <button key={cat.id}
                      ref={isSelected ? function(el) { if (el) el.scrollIntoView({ block: "nearest" }); } : null}
                      onClick={function() { setDraft(Object.assign({}, draft, { category: cat.label, categoryEmoji: cat.emoji })); }}
                      className={"text-xs px-2.5 py-1 rounded-full border transition " + (isSelected ? "bg-blue-600 text-white border-blue-600" : "bg-white text-gray-600 border-gray-200")}>
                      {cat.emoji} {cat.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">הערה</label>
              <input value={draft.note} onChange={function(e) { setDraft(Object.assign({}, draft, { note: e.target.value })); }} placeholder="אופציונלי"
                className="w-full border border-gray-200 rounded-xl px-4 py-3 text-right focus:outline-none focus:border-blue-400" />
            </div>
          </div>
        </Modal>
      );
    }

    // ── ADD SCREEN ────────────────────────────────────────────────────────────────
    function AddScreen({ user, listId, listType, listName, onBack, onMenu, showToast, showStickyToast }) {
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
      // Loaded once on mount instead of re-reading on every "process" click —
      // AI settings don't change mid-session, so that was a fully avoidable
      // round-trip stacked in front of the actual (much slower) AI call
      // every single time, including on retries after an error.
      const aiSettingsRef = useRef(undefined); // undefined = not loaded yet, null = loaded but unset
      useEffect(function() {
        db.ref("users/" + user.uid + "/ai").once("value").then(function(snap) {
          aiSettingsRef.current = snap.val() || null;
        }, function() { aiSettingsRef.current = null; });
      }, [user.uid]);

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
        setSaving(true);

        var activeExisting = existingItems.filter(function(i) { return !i.done; });
        var similar = [];
        var toAdd = [];

        itemsArr.forEach(function(item) {
          var rawName = ((item.name || item.item || "").trim());
          if (!rawName) return;

          // Compares against each existing item's ORIGINAL typed name, not
          // its current one. Still added, just flagged — this is a guess,
          // not a confirmed duplicate.
          var nLower = rawName.toLowerCase();
          var similarExisting = activeExisting.find(function(ex) {
            return ((ex.originalName || ex.name || "").trim().toLowerCase()) === nLower;
          });
          if (similarExisting) similar.push(rawName + ' (דומה ל-"' + similarExisting.name + '")');

          toAdd.push(item);
        });

        if (similar.length > 0) showStickyToast([{ title: "נוסף, אך יש פריט דומה ברשימה:", lines: similar }]);

        if (!toAdd.length) { setSaving(false); return; }

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
        var loadAi = aiSettingsRef.current !== undefined
          ? Promise.resolve(aiSettingsRef.current)
          : db.ref("users/" + user.uid + "/ai").once("value").then(function(snap) { return snap.val() || null; });
        loadAi.then(function(ai) {
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
            <Header onBack={onBack} onMenu={onMenu} title={"הוסף מנות ל" + (listName || "")} />
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
          <Header onBack={onBack} onMenu={onMenu} title="הוסף מטלה" />
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
          <Header onBack={onBack} onMenu={onMenu} title={isTasks ? "הוסף מטלה" : ("הוסף ל" + listDisplayName)} />
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
