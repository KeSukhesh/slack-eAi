import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export function createOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );
  return client;
}

export function getAuthUrl() {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
}

export async function getTokens(code: string) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

export function getCalendarClient(tokens: any) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);
  return google.calendar({ version: 'v3', auth: client });
}

export async function listCalendars(tokens: any) {
  const calendar = getCalendarClient(tokens);
  const res = await calendar.calendarList.list();
  return res.data.items ?? [];
}

export async function createCalendarEvent(tokens: any, calendarId: string, eventDetails: {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendeesEmails?: string[];
}) {
  const calendar = getCalendarClient(tokens);
  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: eventDetails.summary,
      description: eventDetails.description,
      start: eventDetails.start,
      end: eventDetails.end,
      attendees: eventDetails.attendeesEmails?.map(email => ({ email })) ?? [],
    },
  });
  return res.data;
}

export async function updateCalendarEvent(tokens: any, calendarId: string, eventId: string, updates: {
  summary?: string;
  description?: string;
  startDateTime?: string;
  endDateTime?: string;
  attendeesEmails?: string[];
}) {
  const calendar = getCalendarClient(tokens);
  const res = await calendar.events.patch({
    calendarId,
    eventId,
    requestBody: {
      summary: updates.summary,
      description: updates.description,
      start: updates.startDateTime ? { dateTime: updates.startDateTime } : undefined,
      end: updates.endDateTime ? { dateTime: updates.endDateTime } : undefined,
      attendees: updates.attendeesEmails?.map(email => ({ email })),
    },
  });
  return res.data;
}

export async function deleteCalendarEvent(tokens: any, calendarId: string, eventId: string) {
  const calendar = getCalendarClient(tokens);
  await calendar.events.delete({ calendarId, eventId });
  return { success: true };
}

export async function listUpcomingEvents(tokens: any, calendarId: string, maxResults = 50) {
  const calendar = getCalendarClient(tokens);
  const res = await calendar.events.list({
    calendarId,
    timeMin: new Date().toISOString(),
    maxResults,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items ?? [];
  return events.map(event => ({
    id: event.id,
    summary: event.summary,
    description: event.description || "",
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    htmlLink: event.htmlLink,
  }));
}
