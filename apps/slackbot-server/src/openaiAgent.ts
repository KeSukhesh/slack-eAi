import { z } from "zod";
import { generateObject, NoObjectGeneratedError } from "ai";
import { openai } from "@ai-sdk/openai";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent, listUpcomingEvents } from "./calendar.js";
import natural from "natural";

const todayDate = getTodayISODate();
const TfIdf = natural.TfIdf;

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

    if (action === "delete") {
      let resolvedEventId = eventId;
      let matchedEvent = null;

      if (!resolvedEventId && summary) {
        const events = await listUpcomingEvents(userTokens, calendarId, 50);
        const enrichedEvents = events.map((e) => ({
          id: e.id!,
          summary: e.summary!,
          description: e.description ?? "",
          start: e.start!,
          htmlLink: e.htmlLink ?? undefined,
        }));

        const fuzzyResult = await getFuzzyDeleteMatches(summary, enrichedEvents);
        const bestMatch = fuzzyResult.topMatches?.[0];

        if (!bestMatch || bestMatch.score < 0.8) {
          return `⚠️ I couldn't confidently find an event to delete matching *"${summary}"*.`;
        }

        // Return fuzzy match object instead of deleting
        return {
          type: "fuzzy-delete-preview",
          summary,
          topMatches: fuzzyResult.topMatches,
        } satisfies FuzzyDeletePreview;
      }

      if (!resolvedEventId) return `⚠️ No event ID found to delete.`;

      await deleteCalendarEvent(userTokens, calendarId, resolvedEventId);
      return `✅ Deleted event with ID *${resolvedEventId}*.`;
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

type FuzzyDeletePreview = {
  type: "fuzzy-delete-preview";
  summary: string;
  topMatches: {
    id: string;
    summary: string;
    start: string;
    score: number;
    htmlLink?: string;
  }[];
};

const FuzzyDeletePreviewSchema = z.object({
  type: z.literal("fuzzy-delete-preview"),
  summary: z.string(),
  topMatches: z.array(
    z.object({
      id: z.string(),
      summary: z.string(),
      start: z.string(),
      score: z.number(),
      htmlLink: z.string().optional(),
    })
  ),
});

function sortByTfIdfSimilarity(userInput: string, events: { id: string; summary: string; description?: string; start: string; htmlLink?: string | null }[]) {
  const tfidf = new TfIdf();
  const normalizedInput = normalize(userInput);

  // Index all events with normalized text
  const eventDocs = events.map((e) => ({
    ...e,
    combined: normalize(`${e.summary} ${e.description ?? ""}`),
  }));

  eventDocs.forEach((e) => tfidf.addDocument(e.combined));

  // Compute cosine similarity for each
  const scores = eventDocs.map((e, i) => ({
    ...e,
    similarity: tfidf.tfidf(normalizedInput, i),
  }));

  return scores.sort((a, b) => b.similarity - a.similarity).slice(0, 10); // top 10 for LLM
}

async function getFuzzyDeleteMatches(userText: string, events: Array<{ id: string; summary: string; description?: string; start: string; htmlLink?: string | null }>) {
  const topCandidates = sortByTfIdfSimilarity(userText, events);

  const result = await generateObject({
    model: openai("gpt-4o"),
    schema: FuzzyDeletePreviewSchema,
    prompt: `
  You're a Slack assistant that helps users delete the correct Google Calendar event.

  Given a user request and a list of upcoming events (in JSON), return a ranked list of 1-3 matching events (with confidence scores from 0 to 1).

  Each event may include a score_hint field (0–1 cosine similarity to user's query). You may use it to guide your ranking.

  Only return high-confidence matches. Format your output exactly like this:
  {
    "type": "fuzzy-delete-preview",
    "summary": "...",
    "topMatches": [
      { "id": "...", "summary": "...", "start": "...", "score": 0.9, "htmlLink": "https://..." }
    ]
  }

  User said: "${userText}"

  Upcoming events (JSON):
  ${JSON.stringify(topCandidates.map(({ id, summary, description, start, similarity, htmlLink }) => ({
    id,
    summary,
    description,
    start,
    score_hint: similarity,
    htmlLink,
  })), null, 2)}`
  });

  return result.object;
}

function normalize(str: string) {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // remove punctuation
    .replace(/\s+/g, " ")    // collapse spaces
    .trim();
}
