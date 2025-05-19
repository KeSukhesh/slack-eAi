import "dotenv/config";
import bolt from "@slack/bolt";
import express from "express";
import { chatWithOpenAI } from "./openaiAgent.js";
import { getAuthUrl, listCalendars } from "./calendar.js";

const { App, ExpressReceiver } = bolt;

let userTokens: any = null;
console.log("Using GOOGLE_REDIRECT_URI:", process.env.GOOGLE_REDIRECT_URI);

// Setup Express Receiver to listen on /slack/events
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  endpoints: "/slack/events",});

// Initialize Bolt App with the receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  receiver,
});

// Slash command /ping
app.command("/ping", async ({ ack, say }) => {
  await ack();
  await say("Pong! 🏓");
});

// App mention handler (@YourBot ...)
app.event("app_mention", async ({ event, say }) => {
  const text = (event as any).text;
  console.log("App mentioned with text:", text);

  try {
    const response = await chatWithOpenAI(text);
    await say(response ?? "Hmm... I couldn't generate a response.");
  } catch (error) {
    console.error("Error calling chatWithOpenAI:", error);
    await say("⚠️ Sorry, something went wrong while generating a response.");
  }
});

// Slash command /calendar
app.command("/calendar", async ({ ack, command, say }) => {
  await ack();
  const args = command.text.trim().split(/\s+/);

  if (args[0] === "list") {
    try {
      // TODO: Replace with real tokens once user linking is done
      if (!userTokens) {
        await say("⚠️ You need to connect your Google Calendar first. Run `/calendar connect`.");
        return;
      }

      const calendars = await listCalendars(userTokens);
      if (calendars.length === 0) {
        await say("You have no calendars.");
      } else {
        const calendarNames = calendars.map((c) => `• ${c.summary ?? "Unnamed Calendar"}`).join("\n");
        await say(`Here are your calendars:\n${calendarNames}`);
      }
    } catch (error) {
      console.error("Failed to list calendars:", error);
      await say("⚠️ Failed to list calendars.");
    }
  } else if (args[0] === "connect") {
    const authUrl = getAuthUrl();
    await say(`Please connect your Google Calendar: ${authUrl}`);
  } else {
    await say("Unknown subcommand. Try `/calendar list` or `/calendar connect`.");
  }
});

// Optional health check
const healthApp = express();
healthApp.get("/", (_req, res) => {
  res.send("EA Agent API is running ✅");
});

healthApp.use((req, _res, next) => {
  console.log("Incoming Request:", req.method, req.url);
  next();
});


// Handle Google OAuth2 Callback
healthApp.get("/api/google/callback", (req, res) => {
  const code = req.query.code as string;

  if (!code) {
    res.status(400).send("Missing authorization code.");
    return;
  }

  import("./calendar.js")
    .then(({ getTokens }) => getTokens(code))
    .then((tokens) => {
      console.log("✅ Received tokens:", tokens);

      // ✅ Store tokens in memory for testing
      userTokens = tokens;

      res.send(`
        <h1>✅ Connected Successfully</h1>
        <p>You can now return to Slack and use the /calendar command.</p>
      `);
    })
    .catch((error) => {
      console.error("Error exchanging code for tokens:", error);
      res.status(500).send("Failed to exchange code for tokens.");
    });
});


// Mount Slack receiver and health check
const PORT = process.env.PORT || 3000;
healthApp.use(receiver.router);

healthApp.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});