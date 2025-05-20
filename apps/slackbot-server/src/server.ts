import "dotenv/config";
import bolt from "@slack/bolt";
import type { KnownBlock } from "@slack/web-api";
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
    htmlLink?: string;
  }[];
};

function isFuzzyDeletePreview(obj: unknown): obj is FuzzyDeletePreview {
  if (!obj || typeof obj !== "object") return false;
  const typedObj = obj as Record<string, unknown>;
  return (
    typedObj.type === "fuzzy-delete-preview" &&
    Array.isArray(typedObj.topMatches)
  );
}

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

    console.log("Reply type:", typeof reply, "Keys:", Object.keys(reply));

    if (isFuzzyDeletePreview(reply)) {
      console.log("1232122323232323");
      const { summary, topMatches } = reply;

      if (!topMatches.length) {
        await say(`⚠️ Couldn't find any matching events for: "${summary}".`);
        return;
      }

      const top = topMatches[0];

      if (top.score >= 0.9) {
        // Confident match – ask user to confirm in-channel
        console.log("MAMAMAMMAMAMAMMMAMMAMAMAMAM")
        await client.chat.postMessage({
          channel: event.channel,
          text: `🗑️ Top match: *${top.summary}* at ${top.start || "Unknown time"}`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text:
                  `🗑️ I found *${top.summary}* at ${top.start || "Unknown time"}.\n` +
                  (top.htmlLink ? `🔗 <${top.htmlLink}|View event on Google Calendar>\n` : "") +
                  `Do you want to delete it?`,
              },
            },
            {
              type: "actions",
              block_id: "confirm_delete_action",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "✅ Confirm" },
                  style: "primary",
                  value: JSON.stringify({ action: "delete", eventId: top.id, summary: top.summary }),
                  action_id: "confirm_delete_action",
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "❌ Cancel" },
                  style: "danger",
                  value: JSON.stringify({ action: "discard" }),
                  action_id: "discard_action",
                },
              ],
            },
          ],
        });
      } else {
        // Ambiguous match — show list of delete buttons
        const blocks: Array<KnownBlock> = topMatches.slice(0, 3).flatMap((match, i) => [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `• *${match.summary}* – ${match.start}\nConfidence: *${Math.round(match.score * 100)}%*`,
            },
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Delete" },
              style: "danger",
              action_id: `delete_match_${i}`,
              value: JSON.stringify({ eventId: match.id, summary: match.summary }),
            },
          },
          { type: "divider" },
        ]);

        // Add cancel button
        blocks.push({
          type: "actions",
          block_id: "cancel_fuzzy_delete",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "❌ Cancel" },
              action_id: "cancel_fuzzy_delete",
              style: "danger",
            },
          ],
        });

        await client.chat.postMessage({
          channel: event.channel,
          text: `❓ Found multiple possible matches for *"${summary}"*. Which one should I delete?`,
          blocks,
        });
      }

      return;
    }

    if (typeof reply === "string" && reply.startsWith("✅ Event created")) {
      await say(reply);
    } else {
      await say(reply);
    }
  } catch (error) {
    console.error("Error handling calendar action:", error);
    await say("⚠️ Sorry, something went wrong while processing your request.");
  }
});

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

app.action("confirm_delete_action", async ({ ack, body, client }) => {
  await ack();
  const payload = JSON.parse((body as any).actions[0].value);

  if (payload.action === "delete") {
    const { eventId, summary } = payload;

    try {
      await deleteCalendarEvent(userTokens, "primary", eventId);
      await client.chat.postMessage({
        channel: (body as any).channel.id,
        text: `✅ Deleted event *${summary}*.`,
      });
    } catch (err) {
      console.error("Failed to delete event:", err);
      await client.chat.postMessage({
        channel: (body as any).channel.id,
        text: "⚠️ Failed to delete event.",
      });
    }
  }
});

app.action("discard_action", async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: (body as any).channel.id,
    text: "❌ Cancelled.",
  });
});

["delete_match_0", "delete_match_1", "delete_match_2"].forEach((actionId) => {
  app.action(actionId, async ({ ack, body, client, action }) => {
    await ack();

    const { eventId, summary } = JSON.parse((action as any).value);

    try {
      await deleteCalendarEvent(userTokens, "primary", eventId);
      await client.chat.postMessage({
        channel: (body as any).channel.id,
        text: `✅ Deleted event *${summary}*.`,
      });
    } catch (err) {
      console.error("Failed to delete event:", err);
      await client.chat.postMessage({
        channel: (body as any).channel.id,
        text: `⚠️ Failed to delete event.`,
      });
    }
  });
});

app.action("cancel_fuzzy_delete", async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: (body as any).channel.id,
    text: "❌ Cancelled deletion request.",
  });
});


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

// Mount Slack receiver and health check
const PORT = process.env.PORT || 3000;
healthApp.use(receiver.router);

healthApp.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});