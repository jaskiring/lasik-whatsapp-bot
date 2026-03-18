/**
 * LASIK WhatsApp Bot — Production Grade v3
 *
 * Changes from v2:
 *   Fix 1  Debounced session persistence (concurrency-safe)
 *   Fix 2  Strict name validation (rejects "yes", "ok", numbers)
 *   Fix 3  Knowledge responses blocked during data-collection states
 *   Fix 4  API_URL reads from process.env.API_URL (deployment-safe)
 *   Up 1   Follow-up ping scheduled 30 min after timeout ingest
 *   Up 2   Lead scoring — intent_band (HOT/WARM/COLD) + intent_score
 */

const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const INACTIVITY_MS = 2 * 60 * 1000;                          // 2 minutes
const API_URL       = process.env.API_URL;
console.log("[CHATBOT] API_URL:", API_URL);
if (!API_URL) {
  console.error("[CHATBOT] ❌ Missing API_URL env variable");
}
const BOT_SECRET    = process.env.BOT_SECRET || "RELIVE_BOT_SECRET";
const SESSION_FILE  = path.join(__dirname, "sessions.json");

// States in which knowledge responses are ALLOWED (Fix 3)
const KNOWLEDGE_ALLOWED_STATES = new Set(["GREETING", "ASK_PERMISSION", "COMPLETE"]);

// ─────────────────────────────────────────────────────────────────────────────
// Fix 1 — DEBOUNCED SESSION PERSISTENCE (concurrency-safe)
// In-memory sessions = single source of truth at runtime.
// Disk write is debounced 200ms so rapid concurrent messages don't cause races.
// ─────────────────────────────────────────────────────────────────────────────
let sessions = {};

// Hydrate from disk on startup
try {
  if (fs.existsSync(SESSION_FILE)) {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    for (const [phone, s] of Object.entries(raw)) {
      sessions[phone] = { ...s, inactivityTimer: null };
    }
    console.log(`[SESSION] Hydrated ${Object.keys(sessions).length} sessions from disk`);
  }
} catch (e) {
  console.error("[SESSION] Hydration error:", e.message);
}

let _saveTimeout = null;

/** Debounced write of the full in-memory sessions object to disk. */
function schedulePersist() {
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      // Strip non-serialisable timer refs
      const toWrite = {};
      for (const [p, s] of Object.entries(sessions)) {
        toWrite[p] = {
          state:            s.state,
          data:             s.data,
          ingested:         s.ingested,
          last_activity_at: s.last_activity_at,
        };
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify(toWrite, null, 2));
    } catch (e) {
      console.error("[SESSION] Persist error:", e.message);
    }
  }, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix 2 — STRICT NAME VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
const NAME_BLACKLIST = new Set([
  "yes","ok","okay","haan","ha","no","nah","start","nahi","nope","sure",
  "chalo","bilkul","haan ji","skip","next","continue"
]);

function isValidName(str) {
  if (!str || str.length < 2) return false;
  const cleaned = str.toLowerCase().trim();
  if (NAME_BLACKLIST.has(cleaned)) return false;
  return /^[a-zA-Z\s]+$/.test(str.trim()); // only letters + spaces, no digits
}

// ─────────────────────────────────────────────────────────────────────────────
// Up 2 — LEAD SCORING
// ─────────────────────────────────────────────────────────────────────────────
function scoreSession(session) {
  const d = session.data;
  const fields = ["city","insurance","surgeryCity","timeline"];
  const params = fields.filter(f => d[f] && String(d[f]).trim()).length;

  let band;
  if (params === 4 && d.timeline && d.timeline.toLowerCase().includes("immediately")) {
    band = "HOT";
  } else if (params >= 3) {
    band = "WARM";
  } else {
    band = "COLD";
  }
  return { intent_score: params, intent_band: band };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND TO API — includes trigger, scoring, last_activity_at
// ─────────────────────────────────────────────────────────────────────────────
async function sendToAPI(phone, session, trigger = "complete") {
  const d = session.data;
  const { intent_score, intent_band } = scoreSession(session);
  const payload = {
    phone_number:           phone,
    contact_name:           d.contactName || "WhatsApp Lead",
    city:                   d.city        || "",
    insurance:              d.insurance   || "",
    preferred_surgery_city: d.surgeryCity || "",
    timeline:               d.timeline    || "",
    last_user_message:      d.lastMessage || "",
    user_questions:         "",
    bot_fallback:           trigger === "timeout",
    lead_type:              "surgery",
    ingestion_trigger:      trigger,
    last_activity_at:       session.last_activity_at || new Date().toISOString(),
    intent_score,
    intent_band,
  };

  console.log(`[API] Sending lead | phone=${phone} | trigger=${trigger} | band=${intent_band} | score=${intent_score}`);

  try {
    const res = await axios.post(API_URL, payload, {
      headers: { "Content-Type": "application/json", "x-bot-key": BOT_SECRET },
      timeout: 10000,
    });
    console.log(`[API] Response | action=${res.data.action} | lead_id=${res.data.lead_id}`);
    session.ingested = true;
    schedulePersist();
  } catch (err) {
    const msg = err.response ? JSON.stringify(err.response.data) : err.message;
    console.error(`[API] Failed | phone=${phone} | error=${msg}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INACTIVITY TIMER — 2-min timeout + Up1 follow-up ping at 30 min
// ─────────────────────────────────────────────────────────────────────────────
function resetInactivityTimer(phone) {
  const session = sessions[phone];
  if (!session || session.state === "COMPLETE") return;

  if (session.inactivityTimer) {
    clearTimeout(session.inactivityTimer);
    session.inactivityTimer = null;
  }

  session.inactivityTimer = setTimeout(async () => {
    const s = sessions[phone];
    if (!s) return;
    s.inactivityTimer = null;
    console.log(`[CHATBOT] ⏱ Timer fired — ingesting partial lead | phone=${phone}`);
    await sendToAPI(phone, s, "timeout");

    // Up 1 — Follow-up ping (placeholder for real WhatsApp API)
    setTimeout(() => {
      console.log(`[CHATBOT] 📲 Follow-up ping due | phone=${phone} | band=${scoreSession(s).intent_band}`);
      // TODO: integrate WhatsApp Business API here
      // send("Hi 👋 just checking — would you like help with LASIK consultation?")
    }, 30 * 60 * 1000);

  }, INACTIVITY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION — expanded Hinglish/Hindi, priority-ordered
// Priority: RECOVERY → PAIN → ELIGIBILITY → REFERRAL → COST → YES
// No bare "kitna"/"kitne" to avoid cost collisions
// ─────────────────────────────────────────────────────────────────────────────
const INTENTS = {
  RECOVERY: [
    "recovery","recover","heal","healing",
    "kitne din","kitna time","thik hone me kitna","recover hone me",
    "kitne ghante","kab thik","kab theek","kab tak normal",
    "vision kab clear","vision kab","thik hoga","normal kab",
    "thene me kitna","kitna din lagta","kab se normal"
  ],
  PAIN: [
    "pain","painful","dard","dard hoga","takleef","hurt",
    "pain hota","kya pain","kya dard","dard hoga kya",
    "pain hoga kya","painful hai kya","dard nahi hoga"
  ],
  ELIGIBILITY: [
    "eligible","eligibility","suitable","possible",
    "kar sakta","kar sakti","ho sakta","can i do",
    "karwa sakta","karwa sakti","karwa sakta hu kya",
    "mere liye possible","suitable hu kya","ho sakta kya",
    "kya main","kya ho sakta"
  ],
  REFERRAL: [
    "refer","referral","reward","earn","paisa",
    "kya milega","kitna milega","refer friend","refer kaise","money"
  ],
  COST: [
    "cost","price","charges","fees","kharcha","rate","expense",
    "amount","lasik cost","laser cost","eye surgery cost",
    "total cost","kitna padega","kitne ka padega",
    "kitna hai","kitne ka","kitne ki","price kya","surgery ka price"
  ],
  YES: [
    "yes","haan","ha","haan ji","ok","okay","sure","chalo","start","bilkul"
  ]
};

function detectAllIntents(message) {
  const m = message.toLowerCase();
  return Object.entries(INTENTS)
    .filter(([, words]) => words.some(w => m.includes(w)))
    .map(([intent]) => intent);
}

function detectIntent(message) {
  return detectAllIntents(message)[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE — WhatsApp bullet format
// ─────────────────────────────────────────────────────────────────────────────
const KB = {
  COST: `💰 *LASIK Cost Ranges:*

• Basic LASIK → ₹20,000
• Advanced LASIK → ₹45,000
• Premium / SMILE → ₹90,000

Cost depends on technology used.
Want me to help find the right option for you? 👇`,

  RECOVERY: `⚡ *LASIK Recovery is Fast:*

• Clear vision in 3–12 hours
• Normal routine next day
• Full recovery in 1–2 weeks

Want to check if you're eligible? 👇`,

  PAIN: `✅ *LASIK is Almost Painless:*

• Mild pressure for a few seconds
• No real pain during surgery
• Eye drops for comfort post-op

Want me to check your eligibility? 👇`,

  ELIGIBILITY: `🔍 *LASIK Eligibility Depends On:*

• Eye power (stable for 1+ year)
• Age (18+ years)
• Eye health & corneal thickness

I can check if you're suitable in 2 mins. Shall I? 👇`,

  REFERRAL: `🎁 *LASIK Referral Program:*

• Refer a friend → get *₹1,000*
• Works for any completed surgery
• No limit on referrals

Our specialist will contact you shortly.`,
};

/** Fix 3 — multi-intent response, only allowed in specific states. */
function buildKnowledgeResponse(message, state) {
  if (!KNOWLEDGE_ALLOWED_STATES.has(state)) return null; // Fix 3 — blocked in data-collection states

  const intents = detectAllIntents(message).filter(i => i !== "YES");
  if (intents.length === 0) return null;
  if (intents.length === 1) return KB[intents[0]] || null;

  // Combine top 2
  const r1 = KB[intents[0]] || "";
  const r2 = KB[intents[1]] || "";
  return (r1 && r2) ? `${r1}\n\n─────────────\n\n${r2}` : r1 || r2 || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHATBOT WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Fix 4 (T8 carry-over) — global fail-safe
  try {
    const phone   = req.body.phone;
    const message = (req.body.message || "").trim();
    const msgLow  = message.toLowerCase();

    if (!phone) return res.status(400).json({ error: "phone is required" });

    // ── Init session (in-memory is source of truth) ──────────────────────────
    if (!sessions[phone]) {
      sessions[phone] = { state: "GREETING", data: {}, inactivityTimer: null, ingested: false };
      console.log(`[CHATBOT] New session | phone=${phone}`);
    }

    const session = sessions[phone];

    // T5 — timestamp + last message
    session.last_activity_at = new Date().toISOString();
    session.data.lastMessage  = msgLow;

    // Reset inactivity timer
    resetInactivityTimer(phone);

    // Intent detection
    const intent = detectIntent(msgLow);
    console.log(`[INTENT] Detected: ${intent || "none"} | state=${session.state} | phone=${phone}`);

    // Fix 3 — Knowledge response only when NOT in data-collection states
    const knowledge = buildKnowledgeResponse(msgLow, session.state);
    if (knowledge) {
      schedulePersist();
      return res.json({ reply: knowledge });
    }

    // ── State machine ────────────────────────────────────────────────────────
    let state = session.state;
    let reply = "";

    if (state === "GREETING") {
      reply = `Hi 👋 I'm the LASIK consultation assistant.\n\nWe help patients connect with trusted eye hospitals.\n\nShall I ask a few quick questions to guide you? (Yes/No)`;
      session.state = "ASK_PERMISSION";
    }

    else if (state === "ASK_PERMISSION") {
      if (intent === "YES") {
        reply = `Great 👍\n\nMay I know your name?`;
        session.state = "NAME";
      } else {
        reply = `No problem 😊\n\nFeel free to ask any LASIK questions anytime.`;
      }
    }

    else if (state === "NAME") {
      // Fix 2 — strict validation
      if (isValidName(message)) {
        session.data.contactName = message.replace(/\b\w/g, c => c.toUpperCase());
        reply = `Nice to meet you, ${session.data.contactName}! 😊\n\nWhich city are you currently in?`;
      } else {
        session.data.contactName = "WhatsApp Lead";
        reply = `Which city are you currently in?`;
      }
      session.state = "CITY";
    }

    else if (state === "CITY") {
      session.data.city = message.replace(/\b\w/g, c => c.toUpperCase());
      reply = `Do you have medical insurance?\n\n• Yes\n• No\n• Not sure`;
      session.state = "INSURANCE";
    }

    else if (state === "INSURANCE") {
      session.data.insurance = message;
      reply = `Which city do you prefer for surgery?\n\n• Surat  • Mumbai\n• Pune   • Nagpur`;
      session.state = "SURGERY_CITY";
    }

    else if (state === "SURGERY_CITY") {
      session.data.surgeryCity = message.replace(/\b\w/g, c => c.toUpperCase());
      reply = `When are you planning the surgery?\n\n• Immediately\n• Within 1 month\n• Just exploring`;
      session.state = "TIMELINE";
    }

    else if (state === "TIMELINE") {
      session.data.timeline = message;
      session.state = "COMPLETE";

      if (session.inactivityTimer) {
        clearTimeout(session.inactivityTimer);
        session.inactivityTimer = null;
      }

      const firstName = (session.data.contactName && session.data.contactName !== "WhatsApp Lead")
        ? `, ${session.data.contactName.split(" ")[0]}`
        : "";
      const { intent_band } = scoreSession(session);
      console.log(`[CHATBOT] Flow complete | phone=${phone} | band=${intent_band}`);

      reply = `Perfect${firstName}! 🎉\n\nOur LASIK specialist will contact you shortly.\n\nWe'll guide you through the next steps. 👨‍⚕️`;
      sendToAPI(phone, session, "complete"); // fire-and-forget
    }

    else if (state === "COMPLETE") {
      reply = `Our specialist will contact you shortly. 👨‍⚕️\n\nFeel free to ask any questions.`;
      sendToAPI(phone, session, "complete");
    }

    else {
      reply = `Got it 👍\n\nOur specialist will contact you shortly.`;
    }

    schedulePersist(); // Fix 1 — debounced full-write
    res.json({ reply });

  } catch (err) {
    console.error("[CHATBOT] ❌ Unhandled error:", err.message);
    res.json({ reply: "Got it 👍 Our specialist will contact you shortly." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(3001, () => {
  console.log("[CHATBOT] LASIK bot v3 — port 3001");
  console.log(`[CHATBOT] API_URL: ${API_URL}`);
  console.log(`[SESSION] File: ${SESSION_FILE}`);
  console.log(`[CHATBOT] Inactivity timeout: ${INACTIVITY_MS / 1000}s`);
});
