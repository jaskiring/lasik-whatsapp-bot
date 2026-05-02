/**
 * LASIK WhatsApp Bot — v5.0-trilingual
 * Supports Hindi / English / Hinglish
 */

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "OK", version: "v5.0-trilingual" });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG & ENV VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
const REQUIRED_ENV = ["BOT_SECRET", "WEBHOOK_VERIFY_TOKEN", "WHATSAPP_ACCESS_TOKEN", "PHONE_NUMBER_ID"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[FATAL] Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const INACTIVITY_MS = 2 * 60 * 1000;
const API_URL = "https://relive-cure-backend-production.up.railway.app/api/ingest-lead";
const BOT_SECRET = process.env.BOT_SECRET;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const SESSION_FILE = path.join(__dirname, "sessions.json");

const KNOWLEDGE_ALLOWED_STATES = new Set(["GREETING", "ASK_PERMISSION", "ASK_RESUME", "NAME", "CITY", "COMPLETE"]);

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGE DETECTION
// Detects if user is writing in Hindi (Devanagari), Hinglish, or English
// ─────────────────────────────────────────────────────────────────────────────
function detectLanguage(message) {
  if (!message) return "EN";
  // Devanagari Unicode range
  if (/[\u0900-\u097F]/.test(message)) return "HI";
  // Hinglish keywords
  const hinglishWords = [
    "kya", "hai", "haan", "nahi", "mujhe", "mera", "meri", "aap", "karo", "chahiye",
    "bata", "batao", "theek", "achha", "bolna", "kuch", "nahi", "kaisa", "kaise",
    "kitna", "kitne", "kab", "kahan", "kyun", "kaun", "lagta", "lagti", "samajh",
    "hoga", "hogi", "karwana", "karwani", "dekhna", "karein", "sochna", "pata"
  ];
  const msgLow = message.toLowerCase();
  const hinglishCount = hinglishWords.filter(w => msgLow.includes(w)).length;
  if (hinglishCount >= 1) return "HI"; // treat Hinglish as Hindi for replies
  return "EN";
}

// ─────────────────────────────────────────────────────────────────────────────
// BILINGUAL MESSAGES
// ─────────────────────────────────────────────────────────────────────────────
const MSG = {
  GREETING: {
    EN: "Hi! 👋 I'm your Relive Cure LASIK assistant.\n\nI can help you:\n• Check LASIK eligibility\n• Know the cost\n• Book a free consultation\n\nShall we start? (Yes/No)",
    HI: "नमस्ते! 👋 मैं आपका Relive Cure LASIK असिस्टेंट हूँ।\n\nमैं आपकी मदद कर सकता हूँ:\n• LASIK eligibility check करने में\n• Cost जानने में\n• Free consultation book करने में\n\nक्या हम शुरू करें? (हाँ/नहीं)"
  },
  ASK_NAME: {
    EN: "Great! May I know your name? 😊",
    HI: "बढ़िया! आपका नाम क्या है? 😊"
  },
  ASK_CITY: {
    EN: "Which city are you based in? 📍",
    HI: "आप किस शहर में रहते हैं? 📍"
  },
  ASK_SURGERY_CITY: {
    EN: "Which city would you prefer for the surgery?",
    HI: "आप surgery किस शहर में करवाना चाहेंगे?"
  },
  ASK_INSURANCE: {
    EN: "Do you have medical insurance? (Yes/No)",
    HI: "क्या आपके पास medical insurance है? (हाँ/नहीं)"
  },
  ASK_TIMELINE: {
    EN: "When are you planning to get the surgery done?",
    HI: "आप surgery कब करवाना चाहते हैं?"
  },
  COMPLETE: {
    EN: "🎉 Perfect!\n\nOur LASIK specialist will contact you shortly.\n\nMeanwhile, feel free to ask me about:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍",
    HI: "🎉 बढ़िया!\n\nहमारा LASIK specialist जल्द ही आपसे संपर्क करेगा।\n\nइस बीच, आप मुझसे पूछ सकते हैं:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍"
  },
  DECLINE: {
    EN: "No problem! If you change your mind, just say 'Hi'. Have a great day! 😊",
    HI: "कोई बात नहीं! अगर मन बदलें तो बस 'Hi' लिखें। आपका दिन शुभ हो! 😊"
  },
  INVALID_NAME: {
    EN: "Could you please share your full name? (e.g. Rahul Sharma)",
    HI: "क्या आप अपना पूरा नाम बता सकते हैं? (जैसे: राहुल शर्मा)"
  },
  SPECIALIST_CALL: {
    EN: "👍 Got it!\n\nOur LASIK specialist will call you shortly.\n\nMeanwhile, you can ask me about:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍",
    HI: "👍 समझ गया!\n\nहमारा LASIK specialist जल्द ही आपको call करेगा।\n\nइस बीच, आप पूछ सकते हैं:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍"
  },
  FALLBACK: {
    EN: "I'm here to help with LASIK! You can ask me about:\n\n• 💰 Cost & pricing\n• ⚡ Recovery time\n• 🔍 Eligibility check\n• 📅 Surgery timeline\n• 😊 Is it painful?\n\nOr type *call* to talk to a specialist.",
    HI: "मैं LASIK के बारे में आपकी मदद करने के लिए यहाँ हूँ! आप पूछ सकते हैं:\n\n• 💰 Cost & pricing\n• ⚡ Recovery time\n• 🔍 Eligibility check\n• 📅 Surgery कब करें\n• 😊 दर्द होता है क्या?\n\nया specialist से बात करने के लिए *call* लिखें।"
  },
  WELCOME_BACK: {
    EN: "Welcome back! 👋 Would you like to continue from where we left off? (Yes/No)",
    HI: "वापस आए! 👋 क्या आप वहीं से जारी रखना चाहते हैं जहाँ हमने छोड़ा था? (हाँ/नहीं)"
  },
  POWER_REPLY: {
    EN: "Based on your eye power, you could be a good candidate for LASIK! 👍\n\nWould you like me to check your full eligibility?",
    HI: "आपकी eye power के आधार पर, आप LASIK के लिए suitable हो सकते हैं! 👍\n\nक्या मैं आपकी पूरी eligibility check करूँ?"
  }
};

function t(key, lang) {
  const entry = MSG[key];
  if (!entry) return "";
  return entry[lang] || entry["EN"];
}

// ─────────────────────────────────────────────────────────────────────────────
// SESSION PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
let sessions = {};
const processedMessages = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > 60000) processedMessages.delete(id);
  }
}, 30000);

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
function schedulePersist() {
  clearTimeout(_saveTimeout);
  _saveTimeout = setTimeout(() => {
    try {
      const toWrite = {};
      for (const [p, s] of Object.entries(sessions)) {
        toWrite[p] = {
          state: s.state,
          data: s.data,
          ingested: s.ingested,
          first_ingest_done: s.first_ingest_done || false,
          last_activity_at: s.last_activity_at,
          lang: s.lang || "EN",
          repeat_count: s.repeat_count || {},
          resume_offered: s.resume_offered || false,
          last_intent_handled: s.last_intent_handled || null
        };
      }
      fs.writeFileSync(SESSION_FILE, JSON.stringify(toWrite, null, 2));
    } catch (e) {
      console.error("[SESSION] Persist error:", e.message);
    }
  }, 200);
}

// ─────────────────────────────────────────────────────────────────────────────
// NAME VALIDATION
// ─────────────────────────────────────────────────────────────────────────────
const NAME_BLACKLIST = new Set([
  "yes", "ok", "okay", "haan", "ha", "no", "nah", "start", "nahi", "nope", "sure",
  "chalo", "bilkul", "haan ji", "skip", "next", "continue", "hello", "hi", "hey",
  "theek", "accha", "achha", "bilkul", "thik"
]);

function isValidName(str) {
  if (!str || str.trim().length < 2) return false;
  const cleaned = str.toLowerCase().trim();
  if (NAME_BLACKLIST.has(cleaned)) return false;
  // Allow Devanagari names too
  const hasDevanagari = /[\u0900-\u097F]/.test(str);
  if (hasDevanagari) return str.trim().length >= 2;
  if (!/^[a-zA-Z\s]+$/.test(str.trim())) return false;
  const words = str.trim().split(/\s+/);
  return words.some(w => w.length >= 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAD SCORING
// ─────────────────────────────────────────────────────────────────────────────
function scoreSession(session) {
  const d = session.data;
  const fields = ["city", "insurance", "surgeryCity", "timeline"];
  const params = fields.filter(f => d[f] && String(d[f]).trim()).length;

  let band;
  if (params === 4 && d.timeline && d.timeline.toLowerCase().includes("immediately")) {
    band = "HOT";
  } else if (params >= 3) {
    band = "WARM";
  } else {
    band = "COLD";
  }

  return {
    intent_score: params,
    intent_band: band,
    interest_cost: !!d.interest_cost,
    interest_recovery: !!d.interest_recovery,
    concern_pain: !!d.concern_pain,
    concern_safety: !!d.concern_safety,
    urgency_level: d.timeline?.toLowerCase().includes("immediately") ? "high" : (params >= 2 ? "medium" : "low"),
    is_returning: !!d.is_returning
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND TO API
// ─────────────────────────────────────────────────────────────────────────────
async function sendToAPI(phone, session, trigger = "complete") {
  const d = session.data;
  const scored = scoreSession(session);
  const payload = {
    phone_number: phone,
    contact_name: d.contactName || "WhatsApp Lead",
    city: d.city || "",
    preferred_surgery_city: d.surgeryCity || "",
    timeline: d.timeline || "",
    insurance: d.insurance || "",
    interest_cost: scored.interest_cost,
    interest_recovery: scored.interest_recovery,
    concern_pain: scored.concern_pain,
    concern_safety: scored.concern_safety,
    concern_power: !!d.concern_power,
    intent_level: scored.intent_band || "COLD",
    intent_score: scored.intent_score || 0,
    urgency_level: scored.urgency_level || "low",
    request_call: d.request_call || false,
    last_user_message: d.lastMessage || "",
    ingestion_trigger: trigger,
    language: session.lang || "EN",
    source: "whatsapp",
    bot_version: "v5.0-trilingual",
    first_message_at: d.first_message_at || session.last_activity_at || new Date().toISOString(),
    last_message_at: session.last_activity_at || new Date().toISOString(),
    message_count: d.message_count || 1,
    current_flow_state: session.state || "UNKNOWN"
  };

  axios.get("https://relive-cure-backend-production.up.railway.app/health").catch(() => { });

  for (let i = 1; i <= 5; i++) {
    try {
      const res = await axios.post(API_URL, payload, {
        headers: { "Content-Type": "application/json", "x-bot-key": BOT_SECRET },
        timeout: 40000,
      });
      console.log(`[API] ✅ Success attempt ${i} | id=${res.data.lead_id}`);
      session.ingested = true;
      session.first_ingest_done = true;
      schedulePersist();
      return;
    } catch (err) {
      const statusCode = err.response?.status || "NO_STATUS";
      console.log(`[API] ❌ Attempt ${i} FAILED | status=${statusCode}`);
      if (i < 5) await new Promise(r => setTimeout(r, i * 4000));
      else console.error("❌ FINAL FAILURE: Lead ingestion failed | phone:", phone);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INACTIVITY TIMER
// ─────────────────────────────────────────────────────────────────────────────
function resetInactivityTimer(phone) {
  const session = sessions[phone];
  if (!session || session.state === "COMPLETE") return;
  if (session.inactivityTimer) clearTimeout(session.inactivityTimer);

  session.inactivityTimer = setTimeout(async () => {
    const s = sessions[phone];
    if (!s) return;
    s.inactivityTimer = null;
    await sendToAPI(phone, s, "timeout");
  }, INACTIVITY_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION — Hindi + Hinglish + English
// ─────────────────────────────────────────────────────────────────────────────
const INTENTS = {
  RECOVERY: [
    "recovery", "recover", "healing", "kitne din", "kitna time", "kab tak",
    "how much time", "how long", "time will it take", "recover time", "recovery time",
    "kitna time lagega", "time lagega", "kitna din lagega", "jaldi theek", "theek kab hoga",
    "ठीक होने", "कितना समय", "कितने दिन", "रिकवरी"
  ],
  PAIN: [
    "pain", "painful", "dard", "dard hoga", "takleef", "hurt", "pain hota",
    "kya pain", "kya dard", "dard hoga kya", "pain hoga kya", "dard nahi hoga",
    "दर्द", "तकलीफ", "दर्द होगा", "दर्द होता"
  ],
  ELIGIBILITY: [
    "eligible", "eligibility", "suitable", "possible", "kar sakta", "kar sakti",
    "ho sakta", "can i do", "karwa sakta", "karwa sakti", "mere liye possible",
    "suitable hu kya", "kya main", "mera number", "meri aankhein", "aankhein theek",
    "योग्य", "हो सकता", "कर सकता", "हो सकती"
  ],
  REFERRAL: [
    "refer", "referral", "reward", "earn", "paisa", "kya milega", "kitna milega",
    "refer friend", "refer kaise", "money", "पैसा", "रेफर", "कमाई"
  ],
  COST: [
    "cost", "price", "charges", "fees", "kharcha", "rate", "expense", "amount",
    "lasik cost", "laser cost", "eye surgery cost", "total cost", "kitna padega",
    "kitne ka padega", "kitna hai", "kitne ka", "kitne ki", "price kya",
    "surgery ka price", "kitne paise", "कितना खर्चा", "कीमत", "फीस", "खर्च", "रेट"
  ],
  YES: [
    "yes", "haan", "ha", "haan ji", "ok", "okay", "sure", "chalo", "start", "bilkul",
    "theek hai", "thik hai", "हाँ", "ठीक है", "बिल्कुल", "जरूर"
  ],
  NO: [
    "no", "nahi", "nope", "mat", "nahin", "नहीं", "ना", "मत"
  ],
  TIMELINE: [
    "when", "how soon", "timeline", "schedule", "kab", "kitne din", "kitna time",
    "jaldi", "when can i", "next week", "this week", "earliest", "soon", "immediately",
    "कब", "जल्दी", "इस हफ्ते", "अगले हफ्ते"
  ],
  SAFETY: [
    "scared", "fear", "safe", "risk", "side effects", "nervous", "afraid",
    "dar lag raha", "danger", "dangerous", "khatarnak", "safe hai kya",
    "डर", "खतरा", "सुरक्षित", "साइड इफेक्ट"
  ],
  LOCATION: [
    "where", "location", "address", "kahan hai", "nearest", "gurugram", "gurgaon",
    "delhi", "noida", "clinic", "hospital", "centre", "center",
    "कहाँ", "पता", "क्लिनिक"
  ],
  DOCTOR: [
    "doctor", "surgeon", "specialist", "experience", "qualified", "team", "staff",
    "डॉक्टर", "सर्जन"
  ],
  ALTERNATIVES: [
    "contact lens", "glasses", "specs", "chashma", "alternative", "option",
    "lenses", "spectacles", "vs", "compare",
    "चश्मा", "लेंस"
  ]
};

const SALES_INTENT = [
  "call", "specialist", "advisor", "doctor", "consultation", "appointment",
  "talk", "callback", "interested", "help", "agent", "human", "baat",
  "contact", "phone", "number", "baat karni", "call me", "call back",
  "मुझे call", "बात करनी", "specialist से", "call chahiye", "number do"
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

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE — Bilingual
// ─────────────────────────────────────────────────────────────────────────────
const KB = {
  COST: {
    EN: `💰 *LASIK Cost at Relive Cure:*

LASIK starts from ₹15,000 and can go up to ₹90,000 — the exact cost depends on your eye condition and the technology recommended by the doctor.

The best way to know your exact cost is a *free consultation* where our specialist evaluates your eyes.

Shall I arrange a free consultation for you? 👇`,
    HI: `💰 *Relive Cure में LASIK की Cost:*

LASIK की शुरुआत ₹15,000 से होती है और आँखों की condition के अनुसार ₹90,000 तक हो सकती है।

आपकी exact cost जानने का सबसे अच्छा तरीका है *free consultation* — जहाँ doctor आपकी आँखें check करके बताएंगे।

क्या मैं आपके लिए free consultation arrange करूँ? 👇`
  },
  RECOVERY: {
    EN: `⚡ *LASIK Recovery is Super Fast:*

• Vision clears in 3–12 hours
• Normal routine next day
• Full recovery in 1–2 weeks
• No patches, no bed rest needed

Want to check if you're eligible? 👇`,
    HI: `⚡ *LASIK Recovery बहुत तेज़ है:*

• 3–12 घंटे में vision clear हो जाती है
• अगले दिन से normal routine
• 1–2 हफ्ते में पूरी recovery
• कोई patch या bed rest नहीं

क्या आप eligibility check करना चाहेंगे? 👇`
  },
  PAIN: {
    EN: `✅ *LASIK is Almost Painless:*

• Mild pressure for a few seconds only
• No real pain during surgery
• Numbing eye drops used beforehand
• Mild irritation for a few hours after

Thousands of patients say it was easier than they expected 😊`,
    HI: `✅ *LASIK लगभग दर्द-रहित है:*

• सिर्फ कुछ सेकंड के लिए हल्का pressure
• Surgery के दौरान कोई असली दर्द नहीं
• Numbing eye drops पहले दी जाती हैं
• बाद में कुछ घंटे हल्की जलन हो सकती है

हज़ारों मरीज़ों ने कहा कि यह उनकी सोच से भी आसान था 😊`
  },
  ELIGIBILITY: {
    EN: `🔍 *LASIK Eligibility Depends On:*

• Stable eye power for 1+ year
• Age 18+ years
• Healthy eyes & sufficient corneal thickness
• No major eye diseases

I can check your eligibility in 2 minutes — shall I? 👇`,
    HI: `🔍 *LASIK Eligibility किन बातों पर निर्भर करती है:*

• 1+ साल से stable eye power
• उम्र 18+ साल
• Healthy eyes और पर्याप्त corneal thickness
• कोई बड़ी eye disease नहीं

मैं 2 मिनट में आपकी eligibility check कर सकता हूँ — करूँ? 👇`
  },
  REFERRAL: {
    EN: `🎁 *Relive Cure Referral Program:*

• Refer a friend → Earn *₹1,000*
• Valid for every completed surgery
• No limit on referrals!

Our team will share details when you book. 😊`,
    HI: `🎁 *Relive Cure Referral Program:*

• एक दोस्त को refer करें → *₹1,000* कमाएँ
• हर completed surgery पर valid
• कोई limit नहीं!

Booking पर हमारी team आपको details देगी। 😊`
  },
  SAFETY: {
    EN: `😊 It's completely normal to feel nervous!

LASIK is one of the *safest* eye procedures worldwide:

• 98%+ success rate
• No general anesthesia
• Takes only 10–15 minutes
• Doctors evaluate your eyes before surgery

Would you like to know more or check your eligibility?`,
    HI: `😊 घबराना बिल्कुल normal है!

LASIK दुनिया के *सबसे safe* eye procedures में से एक है:

• 98%+ success rate
• General anesthesia नहीं
• सिर्फ 10–15 मिनट
• Surgery से पहले doctor आँखें check करते हैं

क्या आप eligibility check करना चाहेंगे?`
  },
  TIMELINE: {
    EN: `📅 *LASIK at Relive Cure:*

• Surgery time → 10–15 mins (both eyes)
• Same day discharge
• Next day: back to normal work
• Driving: after 1–2 days

We have slots available this week. Want me to check availability? 👇`,
    HI: `📅 *Relive Cure में LASIK:*

• Surgery time → 10–15 मिनट (दोनों आँखें)
• Same day discharge
• अगले दिन: normal काम पर वापस
• Driving: 1–2 दिन बाद

इस हफ्ते slots available हैं। क्या availability check करूँ? 👇`
  },
  LOCATION: {
    EN: `📍 *Relive Cure Location:*

Unitech Cyber Hub, Gurugram, Haryana

• Near Cyber Hub Metro Station
• Free parking available
• Mon–Sat: 9 AM – 7 PM

Want to book a free consultation visit? 👇`,
    HI: `📍 *Relive Cure का पता:*

Unitech Cyber Hub, Gurugram, Haryana

• Cyber Hub Metro Station के पास
• Free parking available
• सोम–शनि: सुबह 9 – शाम 7 बजे

Free consultation के लिए visit book करें? 👇`
  },
  DOCTOR: {
    EN: `👨‍⚕️ *Our Doctors:*

• Experienced LASIK surgeons
• 10,000+ successful procedures
• Latest laser technology
• Personalized eye evaluation

Would you like to meet our specialist? I can arrange a free consultation call. 👇`,
    HI: `👨‍⚕️ *हमारे Doctors:*

• Experienced LASIK surgeons
• 10,000+ successful procedures
• Latest laser technology
• Personalized eye evaluation

क्या आप specialist से मिलना चाहेंगे? मैं free consultation call arrange कर सकता हूँ। 👇`
  },
  ALTERNATIVES: {
    EN: `👓 *LASIK vs Glasses/Contacts:*

| | LASIK | Glasses/Contacts |
|---|---|---|
| Long-term cost | One-time | Recurring |
| Convenience | High | Low |
| Sports/swimming | ✅ | ❌ |
| Permanence | Permanent | Ongoing |

Most patients never need glasses again after LASIK! Want to check eligibility? 👇`,
    HI: `👓 *LASIK vs Chashma/Lenses:*

• LASIK → एक बार का खर्च, हमेशा के लिए आज़ादी
• Chashma → बार-बार का खर्च, हमेशा की परेशानी
• Sports/swimming → LASIK के साथ बिना चश्मे के ✅

ज़्यादातर मरीज़ LASIK के बाद कभी चश्मा नहीं पहनते! Eligibility check करें? 👇`
  }
};

function buildKnowledgeResponse(message, session) {
  const state = session.state;
  const lang = session.lang || "EN";
  if (!KNOWLEDGE_ALLOWED_STATES.has(state)) return null;

  let intents = detectAllIntents(message).filter(i => i !== "YES" && i !== "NO");

  // Power Detection
  const powerRegex = /[-+]?\d+(\.\d+)?/;
  if (powerRegex.test(message) && message.match(/\d/) && !intents.includes("ELIGIBILITY")) {
    intents.push("ELIGIBILITY");
    session.data.concern_power = true;
  }

  if (intents.length === 0) return null;

  const topIntent = intents[0];
  let baseReply = "";

  if (session.last_intent_handled === topIntent) {
    const shortPhrases = {
      EN: [
        `I covered ${topIntent.toLowerCase()} above — anything else I can help with?`,
        `As mentioned, happy to arrange a specialist call for more details!`,
        `Still thinking about it? Our specialist can answer in detail. Type *call*.`
      ],
      HI: [
        `मैंने ऊपर ${topIntent.toLowerCase()} के बारे में बताया — कुछ और जानना है?`,
        `Specialist से बात करें? बस *call* लिखें।`,
        `और जानकारी चाहिए? हमारा specialist detail में बताएगा। *call* लिखें।`
      ]
    };
    const arr = shortPhrases[lang] || shortPhrases.EN;
    baseReply = arr[Math.floor(Math.random() * arr.length)];
  } else {
    session.last_intent_handled = topIntent;
    const kbEntry = KB[topIntent];
    if (kbEntry) {
      baseReply = kbEntry[lang] || kbEntry.EN;
    }
    if (intents.length > 1 && KB[intents[1]]) {
      const second = KB[intents[1]][lang] || KB[intents[1]].EN;
      if (second) baseReply += `\n\n─────────────\n\n${second}`;
    }
  }

  if (!baseReply) return null;

  // Set Intelligence Flags
  if (intents.includes("COST")) session.data.interest_cost = true;
  if (intents.includes("RECOVERY")) session.data.interest_recovery = true;
  if (intents.includes("PAIN")) session.data.concern_pain = true;
  if (intents.includes("SAFETY")) session.data.concern_safety = true;
  if (intents.includes("TIMELINE")) session.data.timeline = message;

  const ctaMap = {
    EN: "\n\nWould you like to arrange a free specialist consultation?",
    HI: "\n\nक्या आप free specialist consultation लेना चाहेंगे?"
  };
  const cta = ctaMap[lang] || ctaMap.EN;

  const nextStep = getNextQuestion(session, "resume");
  const flowResume = nextStep.text ? `\n\n─────────────\n\n${nextStep.text}` : "";

  return baseReply + cta + flowResume;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEXT QUESTION — Bilingual
// ─────────────────────────────────────────────────────────────────────────────
function getNextQuestion(session, context = "normal") {
  const d = session.data;
  const lang = session.lang || "EN";
  const firstName = d.contactName && d.contactName !== "WhatsApp Lead"
    ? d.contactName.split(" ")[0]
    : "";

  let field = null;
  let text = "";

  if (!d.contactName) {
    field = "NAME";
    text = t("ASK_NAME", lang);
  } else if (!d.city) {
    field = "CITY";
    text = t("ASK_CITY", lang);
  } else if (!d.surgeryCity) {
    field = "SURGERY_CITY";
    text = t("ASK_SURGERY_CITY", lang);
  } else if (!d.insurance) {
    field = "INSURANCE";
    text = t("ASK_INSURANCE", lang);
  } else if (!d.timeline) {
    field = "TIMELINE";
    text = t("ASK_TIMELINE", lang);
  }

  if (!field) return { text: "", field: null };

  if (context === "normal" && firstName) {
    const gotItMap = { EN: `Got it, ${firstName} 👍\n\n`, HI: `समझ गया, ${firstName} 👍\n\n` };
    text = (gotItMap[lang] || gotItMap.EN) + text;
  }

  if (context === "resume") {
    const resumeMap = {
      EN: `By the way, could you tell me your ${field.toLowerCase().replace("_", " ")}?`,
      HI: `एक बात और — आपका ${field === "NAME" ? "नाम" : field === "CITY" ? "शहर" : field === "SURGERY_CITY" ? "surgery city" : field === "INSURANCE" ? "insurance" : "timeline"} क्या है?`
    };
    text = resumeMap[lang] || resumeMap.EN;
  }

  return { text, field };
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND WHATSAPP REPLY
// ─────────────────────────────────────────────────────────────────────────────
async function sendWhatsAppReply(phone, reply) {
  const url = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: reply }
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(url, payload, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 10000
      });
      console.log("[WA SEND] ✅ Success");
      return;
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = !status || status === 429 || status >= 500;
      if (isRetryable && attempt < 3) {
        await new Promise(r => setTimeout(r, attempt * 1000));
        continue;
      }
      console.error("[WA SEND FAIL]", { phone, status, error: err.response?.data || err.message });
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK EXISTING LEAD
// ─────────────────────────────────────────────────────────────────────────────
async function checkExistingLead(phone) {
  try {
    const res = await axios.get(
      `https://relive-cure-backend-production.up.railway.app/api/check-lead/${phone}`,
      { headers: { "x-bot-key": BOT_SECRET }, timeout: 10000 }
    );
    return res.data.exists ? res.data.lead : null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK VERIFY
// ─────────────────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[WEBHOOK] ✅ Verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST CHAT ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────
app.post("/chat", async (req, res) => {
  try {
    const reply = await handleIncomingMessage(req.body, true);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CORE MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleIncomingMessage(reqBody, isTestChat = false) {
  let phone, message, msgId;
  let reply = null;
  let replied = false;
  let finalized = false;

  const setReply = (text) => { if (!replied) { reply = text; replied = true; } };

  const finalize = (forceReturn = false) => {
    if (finalized) return reply;
    finalized = true;
    if (!reply) reply = t("FALLBACK", sessions[phone]?.lang || "EN");
    if (!forceReturn) sendWhatsAppReply(phone, reply);
    return reply;
  };

  try {
    // 1. EXTRACT
    if (reqBody?.entry) {
      const messageObj = reqBody.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!messageObj) return;
      phone = messageObj.from;
      message = messageObj.text?.body || "";
      msgId = messageObj.id;
      // Handle non-text messages (voice, image, sticker)
      if (!message && messageObj.type && messageObj.type !== "text") {
        const lang = sessions[phone]?.lang || "EN";
        const nonTextMap = {
          EN: "I can only process text messages right now 😊 Please type your question.",
          HI: "मैं अभी सिर्फ text messages process कर सकता हूँ 😊 कृपया अपना सवाल type करें।"
        };
        await sendWhatsAppReply(phone, nonTextMap[lang] || nonTextMap.EN);
        return;
      }
    } else {
      phone = reqBody.phone;
      message = reqBody.message || "";
      msgId = null;
    }

    if (!phone || !message) return;
    message = message.trim();
    const msgLow = message.toLowerCase();

    console.log(`[MSG] phone=${phone} msg="${message}"`);

    // 2. DEDUP
    const dedupKey = msgId || (phone + "_" + Buffer.from(message).toString("base64").substring(0, 10) + "_" + Math.floor(Date.now() / 1000));
    if (processedMessages.has(dedupKey)) return;
    processedMessages.set(dedupKey, Date.now());

    // 3. LOAD SESSION
    if (!sessions[phone]) {
      const existing = await checkExistingLead(phone);
      sessions[phone] = {
        state: existing ? "RETURNING" : "GREETING",
        data: existing ? { contactName: existing.contact_name, is_returning: true } : {},
        inactivityTimer: null,
        ingested: !!existing,
        first_ingest_done: !!existing,
        lang: detectLanguage(message),
        repeat_count: {},
        last_question_asked: null,
        resume_offered: false,
        last_intent_handled: null
      };
      if (!existing) {
        setImmediate(async () => {
          try { await sendToAPI(phone, sessions[phone], "initial"); }
          catch (e) { console.error("[ASYNC_INGEST_ERROR]", e); }
        });
      }
    }

    const session = sessions[phone];

    // 4. Update language on each message (user may switch languages)
    const detectedLang = detectLanguage(message);
    if (detectedLang === "HI") session.lang = "HI"; // sticky: once Hindi, stay Hindi
    const lang = session.lang || "EN";

    session.last_activity_at = new Date().toISOString();
    if (!session.data.first_message_at) session.data.first_message_at = session.last_activity_at;
    session.data.message_count = (session.data.message_count || 0) + 1;
    session.data.lastMessage = message;
    resetInactivityTimer(phone);

    console.log(`[STATE] phone=${phone} state=${session.state} lang=${lang}`);

    // 5. RESTART CHECK
    const restartWords = ["hi", "hello", "hey", "start", "hii", "helo", "नमस्ते", "हेलो", "शुरू"];
    if (restartWords.some(w => msgLow === w || message === w)) {
      const hasData = session.data.contactName && session.data.contactName !== "WhatsApp Lead";
      if (hasData && !session.resume_offered) {
        session.state = "ASK_RESUME";
        session.resume_offered = true;
        setReply(t("WELCOME_BACK", lang));
        return finalizeWithIngest(phone, session, "update", finalize, isTestChat);
      } else if (!hasData) {
        session.state = "GREETING";
        session.ingested = false;
        session.resume_offered = false;
        session.repeat_count = {};
      }
    }

    // 6. LOGIC PRIORITY

    // A. SALES INTENT — check before anything
    if (isSalesIntent(msgLow)) {
      session.data.request_call = true;
      setReply(t("SPECIALIST_CALL", lang));
      return finalizeWithIngest(phone, session, "update", finalize, isTestChat);
    }

    // B. POWER DETECTION
    if (/[-+]?\d+(\.\d+)?/.test(message) && session.state !== "TIMELINE") {
      session.data.concern_power = true;
      const name = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
      const pfx = name
        ? (lang === "HI" ? `${name}, ` : `Got it, ${name} 👍\n\n`)
        : "";
      const powerMap = {
        EN: `${pfx}Based on your eye power, you could be a great candidate for LASIK! 👍\n\nWould you like me to check your eligibility in detail?`,
        HI: `${pfx}आपकी eye power के आधार पर, आप LASIK के लिए suitable हो सकते हैं! 👍\n\nक्या मैं आपकी eligibility detail में check करूँ?`
      };
      setReply(powerMap[lang] || powerMap.EN);
      return finalizeWithIngest(phone, session, "update", finalize, isTestChat);
    }

    // C. KNOWLEDGE INTENT
    const knowledge = buildKnowledgeResponse(message, session);
    if (knowledge) {
      setReply(knowledge);
      return finalizeWithIngest(phone, session, "knowledge", finalize, isTestChat);
    }

    // D. STATE MACHINE
    const state = session.state;
    session.repeat_count[state] = (session.repeat_count[state] || 0) + 1;

    if (state === "GREETING") {
      setReply(t("GREETING", lang));
      session.state = "ASK_PERMISSION";
    }

    else if (state === "ASK_RESUME") {
      const isYes = ["yes", "haan", "ha", "ok", "okay", "sure", "हाँ", "ठीक", "bilkul"].some(w => msgLow.includes(w));
      if (isYes) {
        const next = getNextQuestion(session);
        const resumeMap = {
          EN: `Awesome! Let's pick up where we left off.\n\n${next.text}`,
          HI: `बढ़िया! चलिए वहीं से शुरू करते हैं जहाँ छोड़ा था।\n\n${next.text}`
        };
        setReply(resumeMap[lang] || resumeMap.EN);
        session.state = next.field;
      } else {
        session.state = "GREETING";
        session.data = {};
        session.repeat_count = {};
        session.resume_offered = false;
        session.lang = lang;
        const freshMap = {
          EN: `No problem! Let's start fresh.\n\n${t("GREETING", lang)}`,
          HI: `कोई बात नहीं! नए सिरे से शुरू करते हैं।\n\n${t("GREETING", lang)}`
        };
        setReply(freshMap[lang] || freshMap.EN);
        session.state = "ASK_PERMISSION";
      }
    }

    else if (state === "RETURNING") {
      const lead = await checkExistingLead(phone);
      if (lead && lead.pushed_to_crm) {
        session.state = "COMPLETE";
        const firstName = session.data.contactName ? session.data.contactName.split(" ")[0] : "";
        const retMap = {
          EN: `Welcome back, ${firstName}! 👋 Your details are already saved ✅\n\nHow can I help you today?\n• Talk to specialist\n• Ask about cost or recovery`,
          HI: `वापस आए, ${firstName}! 👋 आपकी details पहले से saved हैं ✅\n\nआज मैं कैसे help करूँ?\n• Specialist से बात\n• Cost या recovery जानें`
        };
        setReply(retMap[lang] || retMap.EN);
      } else {
        const next = getNextQuestion(session);
        const contMap = {
          EN: `Welcome back! Let's complete your profile.\n\n${next.text}`,
          HI: `वापस आए! चलिए आपकी profile complete करते हैं।\n\n${next.text}`
        };
        setReply(contMap[lang] || contMap.EN);
        session.state = next.field;
      }
    }

    else if (state === "ASK_PERMISSION") {
      const isYes = ["yes", "haan", "ha", "ok", "okay", "sure", "हाँ", "ठीक", "bilkul", "chalo", "चलो", "जरूर"].some(w => msgLow.includes(w));
      if (isYes) {
        const next = getNextQuestion(session);
        setReply(next.text);
        session.state = next.field;
      } else {
        setReply(t("DECLINE", lang));
        session.state = "COMPLETE";
      }
    }

    else if (state === "NAME") {
      if (!isValidName(message)) {
        if (session.repeat_count["NAME"] > 2) {
          // Skip name after 2 failed attempts
          session.data.contactName = "WhatsApp Lead";
          const next = getNextQuestion(session);
          const skipMap = {
            EN: `No problem, let's move on.\n\n${next.text}`,
            HI: `कोई बात नहीं, आगे बढ़ते हैं।\n\n${next.text}`
          };
          setReply(skipMap[lang] || skipMap.EN);
          session.state = next.field;
        } else {
          setReply(t("INVALID_NAME", lang));
        }
      } else {
        session.data.contactName = message;
        const next = getNextQuestion(session);
        setReply(next.text);
        session.state = next.field;
      }
    }

    else if (state === "CITY") {
      session.data.city = message;
      const next = getNextQuestion(session);
      setReply(next.text);
      session.state = next.field;
    }

    else if (state === "SURGERY_CITY") {
      // Handle "same" / "same city" / "wahi" responses
      if (["same", "wahi", "wahi wala", "same city", "same place", "वही", "वही शहर"].some(w => msgLow.includes(w))) {
        session.data.surgeryCity = session.data.city || message;
      } else {
        session.data.surgeryCity = message;
      }
      const next = getNextQuestion(session);
      setReply(next.text);
      session.state = next.field;
    }

    else if (state === "INSURANCE") {
      // Normalize insurance answer
      const hasInsurance = ["yes", "haan", "ha", "hai", "है", "हाँ", "bilkul", "sure"].some(w => msgLow.includes(w));
      const noInsurance = ["no", "nahi", "nope", "nahin", "नहीं", "na", "नहीं है"].some(w => msgLow.includes(w));
      if (hasInsurance) session.data.insurance = "Yes";
      else if (noInsurance) session.data.insurance = "No";
      else session.data.insurance = message;
      const next = getNextQuestion(session);
      setReply(next.text);
      session.state = next.field;
    }

    else if (state === "TIMELINE") {
      session.data.timeline = message;
      session.state = "COMPLETE";
      const name = session.data.contactName && session.data.contactName !== "WhatsApp Lead"
        ? session.data.contactName.split(" ")[0]
        : "";
      const doneMap = {
        EN: `${name ? `Perfect, ${name}! 🎉` : "Perfect! 🎉"}\n\nOur LASIK specialist will contact you shortly.\n\nMeanwhile, I can help you with:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍`,
        HI: `${name ? `बढ़िया, ${name}! 🎉` : "बढ़िया! 🎉"}\n\nहमारा LASIK specialist जल्द ही आपसे संपर्क करेगा।\n\nइस बीच, आप पूछ सकते हैं:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍`
      };
      setReply(doneMap[lang] || doneMap.EN);
    }

    else if (state === "COMPLETE") {
      const knowledgeAgain = buildKnowledgeResponse(message, session);
      if (knowledgeAgain) {
        setReply(knowledgeAgain);
      } else {
        const doneMap = {
          EN: "Your request is with our team! 👍\n\nAnything else? You can ask about:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍\n\nOr type *call* to speak with a specialist.",
          HI: "आपकी request हमारी team के पास है! 👍\n\nकुछ और जानना है? पूछ सकते हैं:\n• Cost 💰\n• Recovery ⚡\n• Eligibility 🔍\n\nया specialist से बात के लिए *call* लिखें।"
        };
        setReply(doneMap[lang] || doneMap.EN);
      }
    }

    return finalizeWithIngest(phone, session, "update", finalize, isTestChat);

  } catch (err) {
    console.error("[ERROR]", err);
    setReply("Something went wrong. Please try again.");
    finalize();
  } finally {
    schedulePersist();
  }
}

function finalizeWithIngest(phone, session, trigger, finalizeFn, isTestChat = false) {
  setImmediate(async () => {
    try { await sendToAPI(phone, session, trigger); }
    catch (e) { console.error("[ASYNC_INGEST_ERROR]", e); }
  });
  return finalizeFn(isTestChat);
}

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK POST
// ─────────────────────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  console.log("📩 Webhook received");
  res.sendStatus(200);
  try { await handleIncomingMessage(req.body); }
  catch (err) { console.error("[WEBHOOK ERROR]", err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log("🚀 BOT VERSION: v5.0-trilingual");

  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    const selfPingUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/health`;
    setInterval(async () => {
      try { await axios.get(selfPingUrl); console.log("[HEARTBEAT] ✅"); }
      catch (err) { console.warn("[HEARTBEAT] ❌", err.message); }
    }, 4 * 60 * 1000);
  }
});