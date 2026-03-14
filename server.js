const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

let sessions = {};

app.post("/webhook", async (req, res) => {
  const phone = req.body.phone || "test";
  const message = (req.body.message || "").toLowerCase();

  if (!sessions[phone]) {
    sessions[phone] = { step: 0 };
  }

  let reply = "";

  switch (sessions[phone].step) {
    case 0:
      reply = "Hi 👋 Thanks for contacting us regarding LASIK surgery.\n\nWhich city are you in?";
      sessions[phone].step = 1;
      break;

    case 1:
      sessions[phone].city = message;
      reply = "Do you have medical insurance?\n\nYes / No / Not sure";
      sessions[phone].step = 2;
      break;

    case 2:
      sessions[phone].insurance = message;
      reply = "Where would you prefer surgery?\nSurat / Mumbai / Pune / Nagpur";
      sessions[phone].step = 3;
      break;

    case 3:
      sessions[phone].surgeryCity = message;
      reply = "When are you planning surgery?\nImmediately / Within 1 month / Just exploring";
      sessions[phone].step = 4;
      break;

    case 4:
      reply = "Thanks 👍 Our LASIK specialist will call you shortly.";
      sessions[phone].step = 5;
      break;

    default:
      reply = "Our specialist will assist you shortly.";
  }

  console.log("Reply:", reply);

  res.json({ reply });
});

app.listen(3000, () => {
  console.log("Bot running");
});
