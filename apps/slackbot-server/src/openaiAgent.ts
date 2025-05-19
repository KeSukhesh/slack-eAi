import { OpenAI } from "openai";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./calendar.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export async function chatWithOpenAI(prompt: string) {
  const completion = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
  });

  return completion.choices[0]?.message.content;
}

export async function handleLlmCalendarAction(text: string, userTokens: any) {
  const prompt = `
You are a calendar assistant. Extract the intent and return JSON in the form:
{ "action": "create|update|delete", "summary": "...", "startDateTime": "...", "endDateTime": "...", "eventId": "...", "calendarId": "..." }

Input: ${text}
`;

  const response = await chatWithOpenAI(prompt);

  try {
    const parsed = JSON.parse(response || "{}");
    const { action, calendarId = "primary", summary, startDateTime, endDateTime, eventId } = parsed;

    if (action === "create") {
      const event = await createCalendarEvent(userTokens, calendarId, { summary, startDateTime, endDateTime });
      return `✅ Event created: ${event.htmlLink}`;
    }

    if (action === "update") {
      const event = await updateCalendarEvent(userTokens, calendarId, eventId, { summary });
      return `✅ Event updated: ${event.htmlLink}`;
    }

    if (action === "delete") {
      await deleteCalendarEvent(userTokens, calendarId, eventId);
      return `✅ Event deleted.`;
    }

    return `⚠️ Could not understand your request.`;
  } catch (err) {
    console.error("Failed to parse LLM response:", response, err);
    return `⚠️ Failed to parse your request.`;
  }
}

