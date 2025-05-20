import "dotenv/config";
import bolt from "@slack/bolt";
import express from "express";
import { handleLlmCalendarAction } from "./openaiAgent.js";
import { getAuthUrl, listCalendars, listUpcomingEvents } from "./calendar.js";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./calendar.js";

const { App, ExpressReceiver } = bolt;

type FuzzyDeletePreview = {
  type: "fuzzy-delete-preview";
  summary: string;
  topMatches: {
    id: string;
    summary: string;
    start: string | null | undefined;
    score: number;
  }[];
};

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
app.event("app_mention", async ({ event, say, client }) => {
  const text = (event as any).text;

  if (!userTokens) {
    await say("⚠️ You need to connect your Google Calendar first. Run `/calendar connect`.");
    return;
  }

  try {
    const reply = await handleLlmCalendarAction(text, userTokens);

    if (isFuzzyDeletePreview(reply)) {
      const top = (reply as any).topMatches[0];

      await client.views.open({
        trigger_id: (event as any).trigger_id,
        view: {
          type: "modal",
          callback_id: "fuzzy_delete_modal",
          private_metadata: JSON.stringify({ eventId: top.id, summary: top.summary }),
          title: { type: "plain_text", text: "Confirm Delete" },
          submit: { type: "plain_text", text: "Delete" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `Top match for *"${(reply as any).summary}"*:\n*${top.summary}*\n🕒 ${top.start || "Unknown time"}`,
              },
            },
          ],
        },
      });
      return;
    }

    if (typeof reply === "string" && reply.startsWith("✅ Event created")) {
      await say(reply);
    } else if (typeof reply === "string" && (reply.includes("update") || reply.includes("delete"))) {
      await say({
        text: reply,
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: reply },
          },
          {
            type: "actions",
            block_id: "calendar_action",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✅ Confirm" },
                style: "primary",
                value: text,
                action_id: "confirm_action",
              },
              {
                type: "button",
                text: { type: "plain_text", text: "❌ Discard" },
                style: "danger",
                value: text,
                action_id: "discard_action",
              },
            ],
          },
        ],
      });
    } else {
      await say(reply);
    }
  } catch (error) {
    console.error("Error handling calendar action:", error);
    await say("⚠️ Sorry, something went wrong while processing your request.");
  }
});

function isFuzzyDeletePreview(obj: any): obj is FuzzyDeletePreview {
  return obj && obj.type === "fuzzy-delete-preview" && Array.isArray(obj.topMatches);
}

// Slash command /calendar
app.command("/calendar", async ({ ack, command, say }) => {
  await ack();
  const args = command.text.trim().split(/\s+/);

  if (args[0] === "list") {
    if (!userTokens) {
      await say("⚠️ You need to connect your Google Calendar first. Run `/calendar connect`.");
      return;
    }
    const calendars = await listCalendars(userTokens);
    if (!calendars.length) {
      await say("You have no calendars.");
      return;
    }

    const calendarDetails = calendars.map(
      (c) => `• *${c.summary ?? "Unnamed"}* — ID: \`${c.id}\``
    ).join("\n");

    await say(`Here are your calendars:\n${calendarDetails}`);
  } else if (args[0] === "connect") {
    const authUrl = getAuthUrl();
    await say(`Please connect your Google Calendar: ${authUrl}`);

  } if (args[0] === "create") {
    if (args.length < 4) {
      await say("Usage: `/calendar create [summary] [startDateTime] [endDateTime]` or `/calendar create [calendarId] [summary] [startDateTime] [endDateTime]`");
      return;
    }

    let calendarId = "primary";
    let summaryIndex = 1;

    // Check if first argument looks like a calendarId (e.g., contains @ or .)
    if (args[1].includes("@") || args[1].includes(".")) {
      calendarId = args[1];
      summaryIndex = 2;
    }

    const summary = args[summaryIndex];
    const startDateTime = args[summaryIndex + 1];
    const endDateTime = args[summaryIndex + 2];

    const timezone = "Australia/Sydney";
    const event = await createCalendarEvent(userTokens, calendarId, {
      summary,
      start: { dateTime: startDateTime, timeZone: timezone },
      end: { dateTime: endDateTime, timeZone: timezone },
    });

    await say(`✅ Event created: ${event.htmlLink}`);
  } else if (args[0] === "update") {
    if (args.length < 3) {
      await say("Usage: `/calendar update [eventId] [newSummary]` or `/calendar update [calendarId] [eventId] [newSummary]`");
      return;
    }

    let calendarId = "primary";
    let eventIdIndex = 1;

    // Check if first argument looks like a calendarId (e.g., contains @ or .)
    if (args[1].includes("@") || args[1].includes(".")) {
      calendarId = args[1];
      eventIdIndex = 2;
    }

    const eventId = args[eventIdIndex];
    const newSummary = args[eventIdIndex + 1];

    const event = await updateCalendarEvent(userTokens, calendarId, eventId, { summary: newSummary });
    await say(`✅ Event updated: ${event.htmlLink}`);

  } else if (args[0] === "delete") {
    if (args.length < 2) {
      await say("Usage: `/calendar delete [eventId]` or `/calendar delete [calendarId] [eventId]`");
      return;
    }

    let calendarId = "primary";
    let eventIdIndex = 1;

    // Check if first argument looks like a calendarId (e.g., contains @ or .)
    if (args[1].includes("@") || args[1].includes(".")) {
      calendarId = args[1];
      eventIdIndex = 2;
    }

    const eventId = args[eventIdIndex];
    await deleteCalendarEvent(userTokens, calendarId, eventId);
    await say(`✅ Event deleted.`);

  } else if (args[0] === "upcoming") {
    if (!userTokens) {
      await say("⚠️ You need to connect your Google Calendar first. Run `/calendar connect`.");
      return;
    }

    const calendarId = args[1] || "primary";
    const events = await listUpcomingEvents(userTokens, calendarId);

    if (events.length === 0) {
      await say("No upcoming events found.");
    } else {
      const eventDetails = events.map(
        (e) => `• *${e.summary ?? "No Title"}* at ${e.start} — ID: \`${e.id}\``
      ).join("\n");

      await say(`Here are your upcoming events:\n${eventDetails}`);
    }
  } else {
    await say("Unknown subcommand. Try `/calendar list`, `/calendar connect`, `/calendar create`, `/calendar update`, or `/calendar delete`.");
  }
});

app.action("confirm_action", async ({ ack, body, client }) => {
  await ack();
  const text = (body as any).actions[0].value;

  await client.chat.postEphemeral({
    channel: (body as any).channel.id,
    user: (body as any).user.id,
    text: "⏳ Working on it...",
  });

  if (!userTokens) {
    await client.chat.postMessage({
      channel: (body as any).channel.id,
      text: "⚠️ You need to connect your Google Calendar first. Run `/calendar connect`.",
    });
    return;
  }

  try {
    const result = await handleLlmCalendarAction(text, userTokens);
    await client.chat.postMessage({
      channel: (body as any).channel.id,
      text: `✅ Confirmed: ${result}`,
    });
  } catch (error) {
    console.error("Error processing confirmed action:", error);
    await client.chat.postMessage({
      channel: (body as any).channel.id,
      text: "⚠️ Failed to process your confirmation.",
    });
  }
});

app.action("discard_action", async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: (body as any).channel.id,
    text: "❌ Discarded.",
  });
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

app.view("fuzzy_delete_modal", async ({ ack, body, view, client }) => {
  await ack();
  const { eventId, summary } = JSON.parse(view.private_metadata);

  try {
    await deleteCalendarEvent(userTokens, "primary", eventId);
    await client.chat.postMessage({
      channel: (body as any).user.id,
      text: `✅ Deleted event *${summary}*.`,
    });
  } catch (err) {
    console.error("Failed to delete event:", err);
    await client.chat.postMessage({
      channel: (body as any).user.id,
      text: `⚠️ Failed to delete event.`,
    });
  }
});

// Mount Slack receiver and health check
const PORT = process.env.PORT || 3000;
healthApp.use(receiver.router);

healthApp.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});