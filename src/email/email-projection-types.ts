// Types and small helpers shared by the email projector and its event mappings.
import type { EmailKind, EmailMessageData } from './email-message-types';

export interface OutboxEvent {
  /** outbox_events.rowid: insertion (commit) order. */
  seq: number;
  id: string;
  event_type: string;
  aggregate_id: string;
  payload_json: string;
  created_at: string;
}

export interface EmailDraft {
  userId: string;
  kind: EmailKind;
  dedupeKey: string;
  data: EmailMessageData;
}

export interface MappingContext {
  db: D1Database;
  origin: string;
  nowMs: number;
  /** Display names of users, loaded in one query per chunk; null for a user that does not exist. */
  displayNames: (userIds: string[]) => Promise<Map<string, string | null>>;
}

/** 'defer' leaves the event unhandled so a later run maps it again (see the lock results mapping). */
export type MappingResult = EmailDraft[] | 'defer';

export type Payload = Record<string, unknown>;

export function parsePayload(json: string): Payload {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {};
  } catch {
    return {};
  }
}

export const productUrl = (origin: string, slug: string) => `${origin}/p/${encodeURIComponent(slug)}`;
