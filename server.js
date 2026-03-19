/**
 * LASIK WhatsApp Bot — Production Grade
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
const KNOWLEDGE_ALLOWED_STATES = new Set(["GREETING", "ASK_PERMISSION", "NAME", "CITY", "INSURANCE", "SURGERY_CITY", "TIMELINE", "COMPLETE"]);

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
          first_ingest_done: s.first_ingest_done,
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

  // Lead Intelligence Fields
  const intelligence = {
    interest_cost:      !!d.interest_cost,
    interest_recovery:  !!d.interest_recovery,
    concern_pain:       !!d.concern_pain,
    concern_safety:     !!d.concern_safety,
    urgency_level:      d.timeline?.toLowerCase().includes("immediately") ? "high" : (params >= 2 ? "medium" : "low"),
    is_returning:       !!d.is_returning
  };

  return { intent_score: params, intent_band: band, ...intelligence };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND TO API — includes trigger, scoring, last_activity_at
// ─────────────────────────────────────────────────────────────────────────────
async function sendToAPI(phone, session, trigger = "complete") {
  const d = session.data;
  const scored = scoreSession(session);
  const payload = {
    phone_number:           phone,
    contact_name:           d.contactName || "WhatsApp Lead",
    city:                   d.city        || "",
    preferred_surgery_city: d.surgeryCity || "",
    timeline:               d.timeline    || "",
    insurance:              d.insurance   || "",

    interest_cost:          scored.interest_cost,
    interest_recovery:      scored.interest_recovery,
    concern_pain:           scored.concern_pain,
    concern_safety:         scored.concern_safety,

    intent_level:           scored.intent_band || "COLD",
    urgency_level:          scored.urgency_level || "low",
    request_call:           d.request_call || false,

    last_user_message:      d.lastMessage || "",
    ingestion_trigger:      trigger
  };

  console.log("[BOT → API]", API_URL, payload);

  console.log("[API DEBUG]", {
    url: API_URL,
    payload
  });

  try {
    const res = await axios.post(API_URL, payload, {
      headers: { 
        "Content-Type": "application/json", 
        "x-bot-key": BOT_SECRET 
      },
      timeout: 10000,
    });
    console.log(`[API] ✅ Success | action=${res.data.action} | id=${res.data.lead_id}`);
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
    "recovery", "recover", "healing",
    "kitne din", "kitna time", "kab tak",
    "how much time", "how long", "time will it take",
    "will it take", "recover time", "recovery time",
    "kitna time lagega", "time lagega", "kitna din lagega",
    "how fast recover", "kitna jaldi recover"
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
  ],
  TIMELINE: [
    "when", "how soon", "timeline", "schedule", "availability",
    "kab", "kitne din", "kitna time", "kab tak", "jaldi",
    "when can i", "how fast", "next week", "this week",
    "earliest", "soon", "immediately", "kitna jaldi"
  ]
};

const SALES_INTENT = [
  "call me", "call back", "contact me", "talk to doctor", "agent se baat",
  "call karna", "phone karo", "baat karni hai", "speak to someone", "human support"
];

function isSalesIntent(message) {
  return SALES_INTENT.some(word => message.toLowerCase().includes(word));
}

function detectAllIntents(message) {
  const m = message.toLowerCase();
  return Object.entries(INTENTS)
    .filter(([, words]) => words.some(w => m.includes(w)))
    .map(([intent]) => intent);
}

function detectIntent(message) {
  return detectAllIntents(message)[0] || null;
}

async function checkExistingLead(phone) {
  try {
    const url = API_URL.replace("/ingest-lead", `/check-lead/${phone}`);
    const res = await axios.get(url, {
      headers: { "x-bot-key": BOT_SECRET },
      timeout: 5000
    });
    return res.data.exists ? res.data.lead : null;
  } catch (e) {
    console.error(`[CHATBOT] Check-lead failed | phone=${phone} | error=${e.message}`);
    return null;
  }
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

  TIMELINE: `📅 *LASIK Timeline:*

• Surgery time → 10–15 mins for both eyes
• Recovery → 4–12 hours
• Resuming work → After 1–2 days

We have slots available this week. Want me to check availability for you? 👇`,
};

/** Multi-intent response, only allowed in specific states. */
function buildKnowledgeResponse(message, state) {
  if (!KNOWLEDGE_ALLOWED_STATES.has(state)) return null;

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
      const existing = await checkExistingLead(phone);
      
      sessions[phone] = { 
        state: existing ? "RETURNING" : "GREETING", 
        data: existing ? { 
          contactName: existing.contact_name,
          is_returning: true,
          interest_cost: existing.interest_cost,
          interest_recovery: existing.interest_recovery,
          concern_pain: existing.concern_pain,
          concern_safety: existing.concern_safety
        } : {}, 
        inactivityTimer: null, 
        ingested: !!existing,
        first_ingest_done: !!existing 
      };

      console.log(`[CHATBOT] New session | phone=${phone} | state=${sessions[phone].state}`);
      
      if (!existing) {
        console.log(`[CHATBOT] First message — creating lead immediately | phone=${phone}`);
        sessions[phone].data.lastMessage = msgLow;
        sendToAPI(phone, sessions[phone], "initial");
        sessions[phone].first_ingest_done = true;
      }
    }

    const session = sessions[phone];

    // T5 — timestamp + last message
    session.last_activity_at = new Date().toISOString();
    session.data.lastMessage  = msgLow;

    // Reset inactivity timer
    resetInactivityTimer(phone);

    const intents = detectAllIntents(msgLow);
    const intent  = intents[0] || null;

    // Update Intelligence based on all intents in message
    if (intents.includes("COST")) session.data.interest_cost = true;
    if (intents.includes("RECOVERY")) session.data.interest_recovery = true;
    if (intents.includes("ELIGIBILITY")) session.data.concern_safety = true; 
    if (intents.includes("PAIN")) session.data.concern_pain = true;

    console.log(`[INTENT] Detected: ${intent || "none"} | state=${session.state} | phone=${phone}`);

    // ── SALES INTENT DETECTION (Part 4) ───────────────────────────────────
    if (isSalesIntent(msgLow)) {
      session.data.request_call = true;
      console.log(`[SALES] Call request detected | phone=${phone}`);
      sendToAPI(phone, session, "update");
      schedulePersist();
      return res.json({ 
        reply: `✅ Done!\n\nOur LASIK specialist will contact you shortly.\n\nMeanwhile, I can also help you with:\n• Cost\n• Recovery\n• Best hospitals` 
      });
    }

    // ── State machine ────────────────────────────────────────────────────────
    let state = session.state;
    let reply = "";

    // STEP 2 — FIX KNOWLEDGE RESPONSE
    const knowledge = buildKnowledgeResponse(msgLow, session.state);
    if (knowledge) {
      reply = knowledge + `\n\nWould you like me to:\n• Check your eligibility\n• Book a consultation\n• Talk to a specialist`;
      sendToAPI(phone, session, "update");
      schedulePersist();
      return res.json({ reply });
    }

    // Helper: Find next step for resumption
    const getNextStep = (s) => {
      const d = s.data;
      if (!d.contactName || d.contactName === "WhatsApp Lead") return "NAME";
      if (!d.city) return "CITY";
      if (!d.surgeryCity) return "SURGERY_CITY";
      if (!d.insurance) return "INSURANCE";
      if (!d.timeline) return "TIMELINE";
      return "COMPLETE";
    };

    if (state === "GREETING") {
      reply = `Hi 👋 I'm the LASIK consultation assistant.\n\nWe help patients connect with trusted eye hospitals.\n\nShall I help you with a few quick details to guide you?`;
      session.state = "ASK_PERMISSION";
    }

    else if (state === "RETURNING" || state === "COMPLETE") {
      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const next = getNextStep(session);
      
      if (next === "COMPLETE") {
        reply = `Welcome back${name ? " " + name : ""} 👋\n\nI have all your details and our specialist is looking into it.\n\nWhat can I help you with now?\n- Check LASIK cost\n- Recovery time\n- Talk to a doctor`;
        session.state = "COMPLETE";
      } else {
        reply = `Welcome back${name ? " " + name : ""} 👋 Let's continue from where we left off.`;
        session.state = next;
        if (next === "NAME") reply += `\n\nMay I know your name?`;
        else if (next === "CITY") reply += `\n\nWhich city are you based in? 📍`;
        else if (next === "SURGERY_CITY") reply += `\n\nWhich city would you prefer for the treatment? (You can choose any city or say "anywhere") 🏥`;
        else if (next === "INSURANCE") reply += `\n\nDo you have medical insurance?`;
        else if (next === "TIMELINE") reply += `\n\nWhen are you planning the surgery?`;
      }
    }

    else if (state === "ASK_PERMISSION") {
      if (intent === "YES" || msgLow.includes("ok") || msgLow.includes("sure")) {
        const next = getNextStep(session);
        session.state = next;
        if (next === "NAME") reply = `Great 👍 May I know your name?`;
        else if (next === "CITY") reply = `Great 👍 Which city are you based in? 📍`;
        else reply = `Great 👍 Let's get started.`;
        sendToAPI(phone, session, "update");
      } else {
        reply = `No worries 👍\n\nYou can ask me about:\n• Cost\n• Recovery\n• Eligibility`;
      }
    }

    else if (state === "NAME") {
      if (isValidName(message)) {
        session.data.contactName = message.replace(/\b\w/g, c => c.toUpperCase());
        const next = getNextStep(session);
        session.state = next;
        reply = `Nice to meet you, ${session.data.contactName}! 😊`;
        if (next === "CITY") reply += `\n\nWhich city are you based in? 📍`;
        else reply += `\n\nWhat else can I help you with?`;
      } else {
        reply = `Sorry, I didn't quite catch that. Could you please tell me your name?`;
      }
      sendToAPI(phone, session, "update");
    }

    else if (state === "CITY") {
      session.data.city = message.replace(/\b\w/g, c => c.toUpperCase());
      const next = getNextStep(session);
      session.state = next;
      reply = `Understood. Which city would you prefer for surgery? (You can choose any city)`;
      sendToAPI(phone, session, "update");
    }

    else if (state === "SURGERY_CITY") {
      if (msgLow.includes("any") || msgLow.includes("flexible") || msgLow.includes("suggest") || msgLow.includes("not sure")) {
        session.data.surgeryCity = "Flexible";
        reply = `Understood. Do you have medical insurance?`;
      } else {
        session.data.surgeryCity = message.replace(/\b\w/g, c => c.toUpperCase());
        reply = `Noted 👍 Do you have medical insurance?`;
      }
      session.state = "INSURANCE";
      sendToAPI(phone, session, "update");
    }

    else if (state === "INSURANCE") {
      session.data.insurance = message;
      const next = getNextStep(session);
      session.state = next;
      if (next === "TIMELINE") reply = `Understood. When are you planning the surgery?`;
      else reply = `Perfect.`;
      sendToAPI(phone, session, "update");
    }

    else if (state === "TIMELINE") {
      session.data.timeline = message;
      session.state = "COMPLETE";

      if (session.inactivityTimer) {
        clearTimeout(session.inactivityTimer);
        session.inactivityTimer = null;
      }

      const firstName = session.data.contactName ? `, ${session.data.contactName.split(" ")[0]}` : "";
      reply = `Perfect${firstName}! 🎉\n\nYou look like a strong candidate for LASIK.\n\nOur LASIK specialist will contact you shortly.\n\nMeanwhile, I can also help you with:\n• Cost\n• Recovery\n• Booking a consultation`;
      sendToAPI(phone, session, "update");
    }

    // STEP 3 — ADD SAFETY GUARD (NO MISSES)
    if (detectAllIntents(msgLow).length > 0) {
      const k = buildKnowledgeResponse(msgLow, "COMPLETE");
      if (k) {
        reply = k + `\n\nWould you like help with next steps?`;
        return res.json({ reply });
      }
    }

    else {
      reply = `I can help you with that 👍\n\nAre you looking for:\n• Cost\n• Recovery\n• Booking a consultation?\n\nIf you prefer, I can also arrange a specialist to guide you.`;
    }

    schedulePersist(); // Fix 1 — debounced full-write
    res.json({ reply });

  } catch (err) {
    console.error("[CHATBOT] ❌ Unhandled error:", err.message);
    res.json({ reply: `I can help you with that 👍\n\nAre you looking for:\n• Cost\n• Recovery\n• Booking a consultation?\n\nIf you prefer, I can also arrange a specialist to guide you.` });
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
