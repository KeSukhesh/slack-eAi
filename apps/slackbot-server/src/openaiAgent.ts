import { z } from "zod";
import { generateObject, NoObjectGeneratedError } from "ai";
import { openai } from "@ai-sdk/openai";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./calendar.js";

const todayDate = getTodayISODate();

const SYSTEM_PROMPT = `
You are EA AI Agent, a Slack-based assistant that helps manage my Google Calendar.

Today's date is ${todayDate}.

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
- "Tomorrow" means ${todayDate} plus one day.
`;


export async function handleLlmCalendarAction(text: string, userTokens: any) {
  const isoDateTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

  const schema = z.object({
    action: z.enum(["create", "update", "delete"]),
    calendarId: z.string().default("primary"),
    summary: z.string().optional(),
    startDateTime: z
      .string()
      .describe('ISO 8601 datetime string "YYYY-MM-DDTHH:MM:SS"')
      .refine((s) => isoDateTimeRegex.test(s), {
        message: "startDateTime must be in 'YYYY-MM-DDTHH:MM:SS' format",
      })
      .optional(),
    endDateTime: z
      .string()
      .describe('ISO 8601 datetime string "YYYY-MM-DDTHH:MM:SS"')
      .refine((s) => isoDateTimeRegex.test(s), {
        message: "endDateTime must be in 'YYYY-MM-DDTHH:MM:SS' format",
      })
      .optional(),
    eventId: z.string().optional(),
  });

  try {
    const { object } = await generateObject({
      model: openai("gpt-3.5-turbo-0125"),
      schema,
      schemaName: "CalendarAction",
      schemaDescription: "Structured calendar action from user request",
      system: SYSTEM_PROMPT,
      prompt: `User request: "${text}"\nOutput:`,
    });

    console.log("LLM Structured Response:", object);

    const { action, calendarId = "primary", summary, startDateTime, endDateTime, eventId } = object;
    const timezone = "Australia/Sydney";

    if (action === "create" && startDateTime && endDateTime && summary) {
      const event = await createCalendarEvent(userTokens, calendarId, {
        summary,
        start: { dateTime: startDateTime, timeZone: timezone },
        end: { dateTime: endDateTime, timeZone: timezone },
      });
      return `✅ Event created: ${event.htmlLink}`;
    }

    if (action === "update" && eventId && summary) {
      const event = await updateCalendarEvent(userTokens, calendarId, eventId, { summary });
      return `✅ Event updated: ${event.htmlLink}`;
    }

    if (action === "delete" && eventId) {
      await deleteCalendarEvent(userTokens, calendarId, eventId);
      return `✅ Event deleted.`;
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
  return today.toISOString().split("T")[0]; // "YYYY-MM-DD"
}