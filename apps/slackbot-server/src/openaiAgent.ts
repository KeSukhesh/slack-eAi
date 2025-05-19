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
You are a calendar assistant. Convert user requests into JSON with the following structure:
{
  "action": "create|update|delete",
  "calendarId": "primary",
  "summary": "...",
  "startDateTime": "YYYY-MM-DDTHH:MM:SS",
  "endDateTime": "YYYY-MM-DDTHH:MM:SS",
  "eventId": "..."
}
Output JSON ONLY. Do not include explanations or comments.

Example 1:
Input: "Schedule team sync tomorrow at 3pm"
Output:
{
  "action": "create",
  "calendarId": "primary",
  "summary": "Team sync",
  "startDateTime": "2025-05-20T15:00:00",
  "endDateTime": "2025-05-20T15:30:00"
}

Example 2:
Input: "Cancel meeting with Alex"
Output:
{
  "action": "delete",
  "calendarId": "primary",
  "eventId": "abc123"
}

Input: ${text}
Output:
`;

  const response = await chatWithOpenAI(prompt);
  console.log("LLM Raw Response:", response);

  const jsonMatch = response?.match(/{[\s\S]*}/);
  if (!jsonMatch) {
    console.error("No valid JSON found in LLM response:", response);
    return `⚠️ Failed to parse your request.`;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const { action, calendarId = "primary", summary, startDateTime, endDateTime, eventId } = parsed;

    const timezone = "Australia/Sydney";

    if (action === "create") {
      const event = await createCalendarEvent(userTokens, calendarId, {
        summary,
        start: { dateTime: startDateTime, timeZone: timezone },
        end: { dateTime: endDateTime, timeZone: timezone },
      });
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
    console.error("Failed to parse JSON from LLM response:", response, err);
    return `⚠️ Failed to parse your request.`;
  }
}
