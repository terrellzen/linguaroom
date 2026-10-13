import { z } from "zod";
export const languages = [
  "bg",
  "de",
  "es",
  "ja",
  "en",
  "ar",
  "zh",
  "fr",
  "hi",
  "it",
  "ko",
  "nl",
  "pl",
  "pt",
  "ro",
  "ru",
  "tr",
  "uk",
  "vi",
  "af",
  "sq",
  "az",
  "eu",
  "be",
  "bn",
  "bs",
  "ca",
  "hr",
  "cs",
  "da",
  "et",
  "fi",
  "gl",
  "el",
  "gu",
  "he",
  "hu",
  "id",
  "kn",
  "kk",
  "lv",
  "lt",
  "mk",
  "ms",
  "ml",
  "mr",
  "no",
  "fa",
  "pa",
  "sr",
  "sk",
  "sl",
  "sw",
  "sv",
  "tl",
  "ta",
  "te",
  "th",
  "ur",
  "cy",
] as const;
export const startSchema = z
  .object({
    key: z.string().min(8).max(512).optional(),
    target: z.enum(languages),
    name: z.string().max(100).default("Meeting"),
    diarization: z.boolean().default(true),
    endpoint: z.boolean().default(true),
    save: z.boolean().default(false),
  })
  .strict();
export type Start = z.infer<typeof startSchema>;
export interface Segment {
  id: string;
  revision: number;
  final: boolean;
  original: string;
  translated: string;
  sourceLanguage?: string;
  targetLanguage: string;
  speakerId?: string;
  startMs?: number;
  endMs?: number;
  channel: "original" | "translation";
}
export type EventType =
  | "session.started"
  | "transcript.updated"
  | "transcript.finalized"
  | "translation.updated"
  | "speaker.updated"
  | "connection.changed"
  | "processing.error"
  | "session.ended";
export interface RoomEvent {
  schemaVersion: 1;
  sessionId: string;
  eventId: string;
  type: EventType;
  timestamp: string;
  providerId: string;
  segment?: Segment;
  message?: string;
}
export interface Snapshot {
  id: string;
  name: string;
  target: string;
  state: string;
  segments: Segment[];
  speakers: Record<string, string>;
  startedAt: string;
  metrics: Record<string, number>;
}
