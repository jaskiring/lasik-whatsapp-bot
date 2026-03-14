const express = require("express");
const app = express();
app.use(express.json());

let sessions = {};

// ----------------------
// INTENT DETECTION
// ----------------------

function detectIntent(message){

  message = message.toLowerCase();

  const costWords = [
    "cost","price","charges","fees","kitna","kitne","kharcha","rate",
    "amount","lasik cost","laser cost","eye surgery cost","kitne ka",
    "kitne ki","price kya","surgery ka price"
  ];

  const recoveryWords = [
    "recovery","recover","heal","healing","kitne din","kitna time",
    "kitne ghante","kab thik","kab theek","rest","vision kab"
  ];

  const painWords = [
    "pain","painful","dard","dard hoga","takleef","hurt","pain hota",
    "kya pain","kya dard"
  ];

  const eligibilityWords = [
    "eligible","eligibility","possible","kar sakta","kar sakti",
    "suitable","ho sakta","can i do","karwa sakta","karwa sakti"
  ];

  const referralWords = [
    "refer","referral","reward","earn","money","paisa",
    "kya milega","kitna milega","refer friend","refer kaise"
  ];

  const yesWords = [
    "yes","haan","ha","haan ji","ok","okay","sure","chalo","start"
  ];

  if(costWords.some(w => message.includes(w))) return "COST";
  if(recoveryWords.some(w => message.includes(w))) return "RECOVERY";
  if(painWords.some(w => message.includes(w))) return "PAIN";
  if(eligibilityWords.some(w => message.includes(w))) return "ELIGIBILITY";
  if(referralWords.some(w => message.includes(w))) return "REFERRAL";
  if(yesWords.some(w => message.includes(w))) return "YES";

  return null;
}

// ----------------------
// KNOWLEDGE BASE
// ----------------------

function knowledgeResponse(intent){

  if(intent === "COST"){
    return `LASIK surgery cost depends on the technology used.

Typical price ranges are:

• Basic LASIK → ₹20k
• Advanced LASIK → ₹45k
• Premium / SMILE → ₹90k

Would you like me to ask a few quick questions to guide you better?`;
  }

  if(intent === "RECOVERY"){
    return `LASIK recovery is very fast.

Most patients see clearly within *3–12 hours* after surgery and can resume normal activities the next day.

Would you like me to check if LASIK might be suitable for you?`;
  }

  if(intent === "PAIN"){
    return `LASIK is almost painless.

You may feel slight pressure for a few seconds during the procedure but there is usually no real pain.

Would you like me to check if you're eligible for LASIK?`;
  }

  if(intent === "ELIGIBILITY"){
    return `LASIK eligibility mainly depends on:

• Eye power
• Age
• Eye health
• Stability of vision

I can ask a few quick questions to check if LASIK might be suitable for you.`;
  }

  if(intent === "REFERRAL"){
    return `We currently run a LASIK referral program.

If someone you refer completes LASIK surgery through our partner hospitals, you receive a reward of *₹1000 per surgery.*

You can refer friends, family, or anyone interested in LASIK.

Our specialist will contact you shortly to explain the process.`;
  }

  return null;
}

// ----------------------
// CHATBOT ENGINE
// ----------------------

app.post("/webhook", (req, res) => {

  const phone = req.body.phone;
  const message = (req.body.message || "").toLowerCase();

  if(!sessions[phone]){
    sessions[phone] = { state: "GREETING", data: {} };
  }

  const intent = detectIntent(message);
  const knowledge = knowledgeResponse(intent);

  if(knowledge){
    return res.json({ reply: knowledge });
  }

  let state = sessions[phone].state;
  let reply = "";

  if(state === "GREETING"){

    reply = `Hi 👋

I'm the LASIK consultation assistant.

We help patients connect with trusted eye hospitals for LASIK treatment.

Would you like me to ask a few quick questions to guide you better?`;

    sessions[phone].state = "ASK_PERMISSION";
  }

  else if(state === "ASK_PERMISSION"){

    if(intent === "YES"){

      reply = "Great 👍\n\nWhich city are you currently in?";

      sessions[phone].state = "CITY";

    } else {

      reply = "No problem 😊\n\nIf you have any LASIK related questions, feel free to ask.";

    }

  }

  else if(state === "CITY"){

    sessions[phone].data.city = message;

    reply = `Do you have medical insurance for treatment?

Yes / No / Not sure`;

    sessions[phone].state = "INSURANCE";
  }

  else if(state === "INSURANCE"){

    sessions[phone].data.insurance = message;

    reply = `Where would you prefer the surgery?

Surat / Mumbai / Pune / Nagpur`;

    sessions[phone].state = "SURGERY_CITY";
  }

  else if(state === "SURGERY_CITY"){

    sessions[phone].data.surgeryCity = message;

    reply = `When are you planning surgery?

Immediately / Within 1 month / Just exploring`;

    sessions[phone].state = "TIMELINE";
  }

  else if(state === "TIMELINE"){

    sessions[phone].data.timeline = message;

    reply = `Thanks for sharing the details 👍

Our LASIK specialist will contact you shortly to guide you further.`;

    sessions[phone].state = "COMPLETE";

    console.log("Lead Captured:", sessions[phone].data);

  }

  else if(state === "COMPLETE"){

    reply = `Our LASIK specialist will contact you shortly and assist you further.`;

  }

  else {

    reply = `Sorry, I may not have understood that properly.

Our LASIK specialist will contact you shortly and assist you personally.`;

  }

  res.json({ reply });

});

app.listen(3000, () => {
  console.log("LASIK bot running");
});
