import type { Snapshot } from "../../../packages/shared/protocol.js";
export function exportTranscript(room: Snapshot, format: string): string {
  if (format === "json") return JSON.stringify(room, null, 2);
  const segments = room.segments.filter((s) => s.final);
  if (format === "txt")
    return segments
      .map(
        (s) =>
          `${room.speakers[s.speakerId ?? ""] ?? s.speakerId ?? "Speaker"} [${s.channel === "translation" ? s.targetLanguage : (s.sourceLanguage ?? "unknown")}] ${s.translated || s.original}`,
      )
      .join("\n");
  if (format !== "srt") throw new Error("Unsupported format");
  const timed = segments.filter(
    (s) => s.startMs !== undefined && s.endMs !== undefined,
  );
  if (!timed.length)
    throw new Error(
      "No valid audio timestamps; translated tokens have no timestamps. Export TXT or JSON.",
    );
  const stamp = (ms: number) =>
    new Date(ms).toISOString().slice(11, 23).replace(".", ",");
  return timed
    .map(
      (s, i) =>
        `${i + 1}\n${stamp(s.startMs!)} --> ${stamp(s.endMs!)}\n${s.original}\n`,
    )
    .join("\n");
}
