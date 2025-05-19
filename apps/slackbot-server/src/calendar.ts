import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

export function createOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI! // e.g. https://yourdomain.com/api/google/callback
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