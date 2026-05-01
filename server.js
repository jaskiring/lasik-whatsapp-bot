/**
 * LASIK WhatsApp Bot — Production Grade
 */

const express = require("express");
const axios   = require("axios");
const fs      = require("fs");
const path    = require("path");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "OK", version: "v2-resumption-final-f9e9dc5" });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const INACTIVITY_MS = 2 * 60 * 1000;                          // 2 minutes
const API_URL       = "https://relive-cure-backend-production.up.railway.app/api/ingest-lead";
const BOT_SECRET    = "RELIVE_BOT_SECRET";
const SESSION_FILE  = path.join(__dirname, "sessions.json");

// States in which knowledge responses are ALLOWED (TIMELINE, SURGERY_CITY, INSURANCE excluded — direct answer required)
const KNOWLEDGE_ALLOWED_STATES = new Set(["GREETING", "ASK_PERMISSION", "ASK_RESUME", "NAME", "CITY", "COMPLETE"]);

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
  if (!str || str.trim().length < 3) return false;
  const cleaned = str.toLowerCase().trim();
  if (NAME_BLACKLIST.has(cleaned)) return false;
  if (!/^[a-zA-Z\s]+$/.test(str.trim())) return false; // only letters + spaces, no digits
  // At least one word must be 3+ characters (prevents "jas" type short fragments alone)
  const words = str.trim().split(/\s+/);
  return words.some(w => w.length >= 3);
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
    concern_power:          !!d.concern_power,

    intent_level:           scored.intent_band || "COLD",
    intent_score:           scored.intent_score || 0,
    urgency_level:          scored.urgency_level || "low",
    request_call:           d.request_call || false,

    last_user_message:      d.lastMessage || "",
    ingestion_trigger:      trigger
  };

  // ── [WAKE] Quick health ping — no force-wait (chatbot is already running)
  axios.get("https://relive-cure-backend-production.up.railway.app/health").catch((e) => {
    console.log("[WAKE] Health ping failed:", e.message);
  });

  for (let i = 1; i <= 5; i++) {
    console.log("[API] Attempt:", i);
    console.log("🔥 SENDING LEAD PAYLOAD:", JSON.stringify(payload, null, 2));
    console.log("🔑 x-bot-key:", BOT_SECRET);
    
    try {
      const res = await axios.post(API_URL, payload, {
        headers: { 
          "Content-Type": "application/json", 
          "x-bot-key": BOT_SECRET
        },
        timeout: 40000,
      });
      console.log(`[API] ✅ Success attempt ${i} | id=${res.data.lead_id}`);
      session.ingested = true;
      schedulePersist();
      return; 
    } catch (err) {
      const statusCode = err.response?.status || 'NO_STATUS';
      const responseBody = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.log(`[API] ❌ Attempt ${i} FAILED | status=${statusCode} | error=${responseBody}`);
      console.log(`[API] ❌ Full error cause:`, err.cause || err.code || 'none');
      
      if (i < 5) {
        const backoff = i * 4000;
        console.log(`[API] Retrying in ${backoff}ms...`);
        await new Promise(r => setTimeout(r, backoff));
      } else {
        console.error("❌ FINAL FAILURE: Lead ingestion failed after all 5 attempts — phone:", phone);
      }
    }
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
  ],
  SAFETY: [
    "scared", "fear", "safe", "risk", "side effects", 
    "nervous", "afraid", "dar lag raha", "danger", "dangerous"
  ]
};

const SALES_INTENT = [
  "call", "specialist", "advisor", "doctor", "consultation", "appointment", 
  "talk", "callback", "interested", "help", "agent", "human", "baat", 
  "contact", "phone", "number", "baat karni", "call me", "call back"
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
    const url = "https://relive-cure-backend-production.up.railway.app/api/check-lead/" + phone;
    const res = await axios.get(url, {
      headers: { "x-bot-key": BOT_SECRET },
      timeout: 10000
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

  SAFETY: `😊 Totally understandable to feel this way

LASIK is one of the safest procedures:

• No major pain
• 10–15 min surgery
• High success rate

Doctors evaluate your eyes before surgery.

Would you like me to check your eligibility?`,

  TIMELINE: `📅 *LASIK Timeline:*

• Surgery time → 10–15 mins for both eyes
• Recovery → 4–12 hours
• Resuming work → After 1–2 days

We have slots available this week. Want me to check availability for you? 👇`,
};

/** Helper for flow resumption */
function getNextQuestion(session) {
  const d = session.data;
  const name = d.contactName ? d.contactName.split(" ")[0] : "";
  const prefix = name ? `Got it, ${name} 👍\n\n` : "";

  if (!d.contactName || d.contactName === "WhatsApp Lead") return `${prefix}May I know your name?`;
  if (!d.city) return `${prefix}Which city are you based in? 📍`;
  if (!d.surgeryCity) return `${prefix}Which city would you prefer for surgery? (You can choose any city)`;
  if (!d.insurance) return `${prefix}Do you have medical insurance?`;
  if (!d.timeline) return `${prefix}When are you planning the surgery?`;
  return "";
}

/** Multi-intent response, now with CTA and Flow Resume */
function buildKnowledgeResponse(message, session) {
  const state = session.state;
  
  if (!KNOWLEDGE_ALLOWED_STATES.has(state)) return null;

  let intents = detectAllIntents(message).filter(i => i !== "YES");
  
  // Power Detection (Requirement 6)
  const powerRegex = /-?\d+(\.\d+)?/;
  if (powerRegex.test(message) && !intents.includes("ELIGIBILITY")) {
    intents.push("ELIGIBILITY");
    session.data.concern_power = true;
  }

  if (intents.length === 0) return null;
  
  let baseReply = "";
  if (intents.length === 1) {
    baseReply = KB[intents[0]] || "";
  } else {
    // Combine top 2
    const r1 = KB[intents[0]] || "";
    const r2 = KB[intents[1]] || "";
    baseReply = (r1 && r2) ? `${r1}\n\n─────────────\n\n${r2}` : r1 || r2 || "";
  }

  if (!baseReply) return null;

  // Set Intelligence Flags (Requirement 6 & 10 Hardening)
  if (intents.includes("COST"))     session.data.interest_cost = true;
  if (intents.includes("RECOVERY")) session.data.interest_recovery = true;
  if (intents.includes("PAIN"))     session.data.concern_pain = true;
  if (intents.includes("SAFETY"))   session.data.concern_safety = true;
  if (intents.includes("TIMELINE")) session.data.timeline = message;

  const cta = "\n\nWould you like me to arrange a quick consultation call?";
  const nextStep = getNextQuestion(session);
  const flowResume = nextStep ? `\n\n─────────────\n\n${nextStep}` : "";

  return baseReply + cta + flowResume;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHATBOT WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "relive_verify_token_123";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

async function sendWhatsAppReply(phone, reply) {
  if (!process.env.WHATSAPP_ACCESS_TOKEN || !process.env.PHONE_NUMBER_ID) {
    console.log('[WA SEND DRY RUN]', phone, '->', reply);
    return;
  }
  const url = `https://graph.facebook.com/v18.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: reply }
  };
  try {
    console.log(`[WA SEND] Sending reply to: ${phone}`);
    console.log("[WA SEND] Using token:", process.env.WHATSAPP_ACCESS_TOKEN?.slice(0,10));
    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });
    console.log("[WA SEND] ✅ Success");
  } catch (err) {
    console.error("[WA SEND ERROR FULL]", err.response?.data || err.message);
  }
}

async function handleIncomingMessage(reqBody) {
  try {
    let phone, message;
    
    // --- Meta Webhook Adapter ---
    if (reqBody && reqBody.entry) {
      const entry = reqBody.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messageObj = value?.messages?.[0];
      if (!messageObj) return; // Ignore status updates
      phone = messageObj.from;
      message = messageObj.text?.body || "";
    } else {
      phone = reqBody.phone;
      message = reqBody.message || "";
    }

    if (!phone || !message) return;
    
    message = message.trim();
    const msgLow = message.toLowerCase();

    console.log(`[SESSION] ${phone} → state: ${sessions[phone]?.state || "NEW"}`);

    if (!sessions[phone]) {
      const existing = await checkExistingLead(phone);

      sessions[phone] = {
        state: existing ? "RETURNING" : "GREETING",
        data: existing ? {
          contactName: existing.contact_name,
          is_returning: true
        } : {},
        inactivityTimer: null,
        ingested: !!existing
      };

      if (!existing) {
        sessions[phone].data.lastMessage = msgLow;
        await sendToAPI(phone, sessions[phone], "initial");
      }
    }

    const session = sessions[phone];

    session.last_activity_at = new Date().toISOString();
    session.data.lastMessage = msgLow;

    resetInactivityTimer(phone);

    const restartWords = ["hi","hello","hey","start","hii","helo"];
    if (session && restartWords.some(w => msgLow === w)) {
      const existingData = session.data || {};
      const hasCollectedSomething = existingData.contactName && 
                                     existingData.contactName !== "WhatsApp Lead";
      
      clearTimeout(session.inactivityTimer);
      
      if (hasCollectedSomething) {
        session.state = "ASK_RESUME";
      } else {
        session.state = "GREETING";
        session.ingested = false;
      }
    }

    // SALES INTENT
    if (isSalesIntent(msgLow)) {
      session.data.request_call = true;
      await sendToAPI(phone, session, "update");

      await sendWhatsAppReply(phone, `👍 Got it!\n\nOur LASIK specialist will call you shortly.\n\nMeanwhile, you can ask me about:\n• Cost\n• Recovery\n• Eligibility`);
      return;
    }

    // POWER DETECTION
    const powerMatch = message.match(/[-+]\d+(\.\d+)?|\b\d+\.\d+\b/);
    if (powerMatch) {
      session.data.concern_power = true;
      await sendToAPI(phone, session, "update");
      
      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const personalPrefix = name ? `Got it, ${name} 👍\n\n` : "Got it 👍\n\n";

      await sendWhatsAppReply(phone, `${personalPrefix}Based on your eye power, you could be a good candidate for LASIK.\n\nWould you like me to check your eligibility quickly?`);
      return;
    }

    // ── TIMELINE STATE OVERRIDE
    if (session.state === "TIMELINE") {
      session.data.timeline = message;
      session.state = "COMPLETE";
      await sendToAPI(phone, session, "update");

      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const personalPrefix = name ? `Perfect, ${name}! 🎉` : "Perfect! 🎉";

      await sendWhatsAppReply(phone, `${personalPrefix}\n\nOur LASIK specialist will contact you shortly.\n\nMeanwhile, I can help you with:\n• Cost\n• Recovery\n• Booking a consultation`);
      return;
    }

    // KNOWLEDGE (GLOBAL)
    const knowledge = buildKnowledgeResponse(msgLow, session);
    if (knowledge) {
      await sendToAPI(phone, session, "knowledge");
      await sendWhatsAppReply(phone, knowledge);
      return;
    }

    const state = session.state;

    // ASK_RESUME — user returned after gap
    if (state === "ASK_RESUME") {
      const d = session.data;
      const name = d.contactName ? d.contactName.split(" ")[0] : "there";
      
      const missing = [];
      if (!d.surgeryCity) missing.push("preferred surgery city");
      if (!d.insurance) missing.push("insurance");  
      if (!d.timeline) missing.push("timeline");
      
      if (missing.length === 0) {
        session.state = "COMPLETE";
        await sendWhatsAppReply(phone, `Welcome back, ${name}! 👋 All your details are saved ✅\n\nOur specialist will contact you shortly.`);
        return;
      }
      
      session.state = "ASK_PERMISSION";
      session.data._resuming = true; 
      
      await sendWhatsAppReply(phone, `Welcome back, ${name}! 👋\n\nWould you like to continue where we left off?\n\nStill needed: ${missing.join(", ")}\n\nReply *Yes* to continue or *No* to just chat 😊`);
      return;
    }

    // GREETING
    if (state === "GREETING") {
      session.state = "ASK_PERMISSION";

      await sendWhatsAppReply(phone, `Hi 👋 I'm the LASIK consultation assistant.\n\nWe help patients connect with trusted eye hospitals.\n\nShall I help you with a few quick details to guide you?`);
      return;
    }

    // ASK PERMISSION
    if (state === "ASK_PERMISSION") {
      const d = session.data;
      
      if (d._resuming) {
        delete session.data._resuming;
        
        if (msgLow.includes("yes") || msgLow.includes("ok") || msgLow.includes("haan") || msgLow.includes("sure") || msgLow.includes("haan ji")) {
          if (!d.surgeryCity) {
            session.state = "SURGERY_CITY";
            await sendWhatsAppReply(phone, `Great! Let's continue 😊\n\nWhich city would you prefer for surgery?`);
            return;
          }
          if (!d.insurance) {
            session.state = "INSURANCE";
            await sendWhatsAppReply(phone, `Great! Let's continue 😊\n\nDo you have medical insurance?`);
            return;
          }
          if (!d.timeline) {
            session.state = "TIMELINE";
            await sendWhatsAppReply(phone, `Great! Let's continue 😊\n\nWhen are you planning the surgery?`);
            return;
          }
        } else {
          session.state = "COMPLETE";
          await sendWhatsAppReply(phone, `No problem! 😊 Feel free to ask me anything:\n• LASIK cost\n• Recovery time\n• Eligibility\n• Book consultation`);
          return;
        }
      }

      if (msgLow.includes("yes") || msgLow.includes("ok") || msgLow.includes("sure") || msgLow.includes("haan")) {
        session.state = "NAME";
        await sendWhatsAppReply(phone, `Great 👍 May I know your name?`);
        return;
      }

      await sendWhatsAppReply(phone, `No worries 😊\n\nYou can ask me about:\n• Cost\n• Recovery\n• Eligibility`);
      return;
    }

    // NAME
    if (state === "NAME") {
      if (!isValidName(message)) {
        await sendWhatsAppReply(phone, `Could you please tell me your name?`);
        return;
      }

      session.data.contactName = message;
      session.state = "CITY";
      await sendToAPI(phone, session, "update");

      const firstName = message.split(" ")[0];
      await sendWhatsAppReply(phone, `Nice to meet you, ${firstName}! 😊\n\nWhich city are you based in? 📍`);
      return;
    }

    // CITY
    if (state === "CITY") {
      session.data.city = message;
      session.state = "SURGERY_CITY";
      await sendToAPI(phone, session, "update");

      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const personalPrefix = name ? `Got it, ${name} 👍\n\n` : "";

      await sendWhatsAppReply(phone, `${personalPrefix}Which city would you prefer for surgery? (You can choose any city)`);
      return;
    }

    // SURGERY CITY
    if (state === "SURGERY_CITY") {
      session.data.surgeryCity = msgLow.includes("any") ? "Flexible" : message;
      session.state = "INSURANCE";
      await sendToAPI(phone, session, "update");

      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const personalPrefix = name ? `Got it, ${name} 👍\n\n` : "";

      await sendWhatsAppReply(phone, `${personalPrefix}Do you have medical insurance?`);
      return;
    }

    // INSURANCE
    if (state === "INSURANCE") {
      session.data.insurance = message;
      session.state = "TIMELINE";
      await sendToAPI(phone, session, "update");

      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const personalPrefix = name ? `Got it, ${name} 👍\n\n` : "";

      await sendWhatsAppReply(phone, `${personalPrefix}When are you planning the surgery?`);
      return;
    }

    // RETURNING
    if (state === "RETURNING") {
      session.state = "COMPLETE";
      const d = session.data;
      const firstName = d.contactName ? d.contactName.split(" ")[0] : "there";
      
      await sendWhatsAppReply(phone, `Welcome back, ${firstName}! 👋\n\nWhat would you like to know?\n• Cost\n• Recovery\n• Talk to a doctor`);
      return;
    }

    // FINAL FALLBACK
    await sendWhatsAppReply(phone, `I didn't fully get that, but I can help with:\n\n• LASIK cost  \n• Recovery time  \n• Eligibility  \n\nOr I can arrange a specialist call for you.`);
    return;

  } catch (err) {
    console.error("Processing error:", err);
    await sendWhatsAppReply(reqBody.phone || (reqBody.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from), `Something went wrong. Please try again.`);
  } finally {
    schedulePersist();
  }
}

app.post("/webhook", async (req, res) => {
  console.log("📩 Incoming webhook received");
  res.sendStatus(200);

  try {
    await handleIncomingMessage(req.body);
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[SERVER] WhatsApp Bot is running on port ${PORT}`);
  console.log("🚀 BOT VERSION: v4-final-render-conn-fix");
  console.log(`[CHATBOT] API_URL: ${API_URL}`);
  console.log(`[SESSION] File: ${SESSION_FILE}`);
  console.log(`[CHATBOT] Inactivity timeout: ${INACTIVITY_MS / 1000}s`);
  console.log(`[CHATBOT] Wake delay: 15000ms (Render cold start)`);
});
