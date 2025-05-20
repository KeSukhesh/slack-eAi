import { z } from "zod";
import { generateObject, NoObjectGeneratedError } from "ai";
import { openai } from "@ai-sdk/openai";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, listUpcomingEvents } from "./calendar.js";

const todayDate = getTodayISODate();

const SYSTEM_PROMPT = `
You are EA AI Agent, a Slack-based assistant that helps manage my Google Calendar.

Today's date is ${todayDate}.

You can request real-time data by calling tools like "listUpcomingEvents" to get upcoming calendar events.

Your task is to read user requests and output ONLY valid JSON in this format:
{
  "action": "create|update|delete",
  "calendarId": "primary",
  "summary": "...",
  "startDateTime": "YYYY-MM-DDTHH:MM:SS",
  "endDateTime": "YYYY-MM-DDTHH:MM:SS",
  "eventId": "..."
}

Guidelines:
- Output JSON ONLY.
- No extra comments or explanations.
- Datetime must be in ISO format: YYYY-MM-DDTHH:MM:SS.
`;

const isoDateTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

const schema = z.object({
  action: z.enum(["create", "update", "delete"]),
  calendarId: z.string().default("primary"),
  summary: z.string().optional(),
  startDateTime: z.string().refine((s) => isoDateTimeRegex.test(s), { message: "startDateTime must be in 'YYYY-MM-DDTHH:MM:SS' format" }).optional(),
  endDateTime: z.string().refine((s) => isoDateTimeRegex.test(s), { message: "endDateTime must be in 'YYYY-MM-DDTHH:MM:SS' format" }).optional(),
  eventId: z.string().optional(),
  toolCall: z.string().optional(),
  parameters: z.any().optional(),
});

export async function handleLlmCalendarAction(text: string, userTokens: any) {
  try {
    let promptContext = `User request: "${text}"`;
    let toolExecutionComplete = false;
    let toolResult = null;

    while (!toolExecutionComplete) {
      const { object } = await generateObject({
        model: openai("gpt-3.5-turbo-0125"),
        schema,
        schemaName: "CalendarAction",
        schemaDescription: "Structured calendar action from user request",
        system: SYSTEM_PROMPT,
        prompt: promptContext,
      });

      console.log("LLM Response:", object);

      if (object.toolCall === "listUpcomingEvents") {
        const calendarId = object.parameters?.calendarId || "primary";
        const events = await listUpcomingEvents(userTokens, calendarId);
        const eventSummaries = events.length
          ? events.map(e => `- ${e.summary} at ${e.start} (ID: ${e.id})`).join("\n")
          : "No events found.";

        promptContext += `\n\nTool response for "listUpcomingEvents":\n${eventSummaries}`;
        continue;
      }

      toolExecutionComplete = true;
      toolResult = object;
    }

    if (!toolResult) {
      return `⚠️ No valid response produced.`;
    }

    const { action, calendarId = "primary", summary, startDateTime, endDateTime, eventId } = toolResult;
    const timezone = "Australia/Sydney";

    if (action === "create" && startDateTime && endDateTime && summary) {
      const event = await createCalendarEvent(userTokens, calendarId, {
        summary,
        start: { dateTime: startDateTime, timeZone: timezone },
        end: { dateTime: endDateTime, timeZone: timezone },
      });

      const startDisplay = formatDateTime(startDateTime, timezone);
      const endDisplay = formatDateTime(endDateTime, timezone);

      return `✅ Event *"${summary}"* created for *${startDisplay} - ${endDisplay}*.\n🔗 <${event.htmlLink}|View it on Google Calendar>`;
    }

    if (action === "update" && eventId && summary) {
      const event = await updateCalendarEvent(userTokens, calendarId, eventId, { summary });
      return `✅ Event updated to *"${summary}"*.\n🔗 <${event.htmlLink}|View it on Google Calendar>`;
    }

    if (action === "delete" && eventId) {
      await deleteCalendarEvent(userTokens, calendarId, eventId);
      return `✅ Event *"${summary || eventId}"* deleted successfully.`;
    }

    return `⚠️ Could not understand your request.`;

  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Validation Error:", error.errors);
      const messages = error.errors.map(e => e.message).join(", ");
      return `⚠️ Invalid data format: ${messages}`;
    }

    if (NoObjectGeneratedError.isInstance(error)) {
      console.error("NoObjectGeneratedError:", error.text, error.cause);
      return `⚠️ The AI could not produce valid data. Please rephrase and try again.`;
    }

    console.error("Unexpected Error:", error);
    return `⚠️ Failed to process your request due to an unexpected error.`;
  }
}

function getTodayISODate() {
  const today = new Date();
  return today.toISOString().split("T")[0];
}

function formatDateTime(isoString: string, timeZone: string) {
  const date = new Date(isoString);
  return date.toLocaleString("en-AU", { timeZone, dateStyle: "medium", timeStyle: "short" });
}

export const listUpcomingEventsTool = {
  name: "listUpcomingEvents",
  description: "Get the user's upcoming Google Calendar events",
  parameters: z.object({
    calendarId: z.string().default("primary").describe("The calendar ID to fetch events from"),
  }),
  execute: async (params: { calendarId: string }, userTokens: any) => {
    const events = await listUpcomingEvents(userTokens, params.calendarId);
    return events.map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start,
      end: e.end,
    }));
  },
};
