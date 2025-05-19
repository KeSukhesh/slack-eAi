import "dotenv/config";
import bolt from "@slack/bolt";
import express from "express";
import { chatWithOpenAI } from "./openaiAgent.js";
import { getAuthUrl, listCalendars } from "./calendar.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./calendar.js";


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
    // ✅ List calendars (already implemented)
    if (!userTokens) {
      await say("⚠️ You need to connect your Google Calendar first. Run `/calendar connect`.");
      return;
    }
    const calendars = await listCalendars(userTokens);
    const calendarNames = calendars.map((c) => `• ${c.summary ?? "Unnamed Calendar"}`).join("\n");
    await say(calendars.length ? `Here are your calendars:\n${calendarNames}` : "You have no calendars.");

  } else if (args[0] === "connect") {
    // ✅ Provide OAuth link (already implemented)
    const authUrl = getAuthUrl();
    await say(`Please connect your Google Calendar: ${authUrl}`);

  } else if (args[0] === "create") {
    // 🆕 Create Event Example: `/calendar create [calendarId] [summary] [startDateTime] [endDateTime]`
    if (args.length < 5) {
      await say("Usage: `/calendar create [calendarId] [summary] [startDateTime] [endDateTime]`");
      return;
    }
    const [calendarId, summary, startDateTime, endDateTime] = args.slice(1);
    const event = await createCalendarEvent(userTokens, calendarId, { summary, startDateTime, endDateTime });
    await say(`✅ Event created: ${event.htmlLink}`);

  } else if (args[0] === "update") {
    // 🆕 Update Event Example: `/calendar update [calendarId] [eventId] [newSummary]`
    if (args.length < 4) {
      await say("Usage: `/calendar update [calendarId] [eventId] [newSummary]`");
      return;
    }
    const [calendarId, eventId, newSummary] = args.slice(1);
    const event = await updateCalendarEvent(userTokens, calendarId, eventId, { summary: newSummary });
    await say(`✅ Event updated: ${event.htmlLink}`);

  } else if (args[0] === "delete") {
    // 🆕 Delete Event Example: `/calendar delete [calendarId] [eventId]`
    if (args.length < 3) {
      await say("Usage: `/calendar delete [calendarId] [eventId]`");
      return;
    }
    const [calendarId, eventId] = args.slice(1);
    await deleteCalendarEvent(userTokens, calendarId, eventId);
    await say(`✅ Event deleted.`);

  } else {
    await say("Unknown subcommand. Try `/calendar list`, `/calendar connect`, `/calendar create`, `/calendar update`, or `/calendar delete`.");
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