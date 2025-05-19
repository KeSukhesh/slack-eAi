import "dotenv/config";
import bolt from "@slack/bolt";
const { App, ExpressReceiver } = bolt;
import express, { Request, Response } from "express";

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

  await say(`You mentioned me with: "${text}"`);
});

// Optional health check
const healthApp = express();
healthApp.get("/", (_req, res) => {
  res.send("EA Agent API is running ✅");
});

// Mount Slack receiver and health check
const PORT = process.env.PORT || 3000;
healthApp.use(receiver.router);

healthApp.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});