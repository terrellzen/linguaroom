import { z } from "zod";
import type { Segment } from "../../../../../packages/shared/protocol.js";
const tokenSchema = z.object({
  text: z.string().max(10000),
  is_final: z.boolean(),
  speaker: z.string().optional(),
  language: z.string().optional(),
  source_language: z.string().optional(),
  translation_status: z.string().optional(),
  start_ms: z.number().optional(),
  end_ms: z.number().optional(),
});
export const responseSchema = z.object({
  tokens: z.array(tokenSchema).max(20000).default([]),
  finished: z.boolean().optional(),
  error_code: z.number().optional(),
  error_type: z.string().optional(),
  total_audio_proc_ms: z.number().optional(),
  final_audio_proc_ms: z.number().optional(),
});
type Token = z.infer<typeof tokenSchema>;
const channel = (t: Token) =>
  t.translation_status === "translation" ? "translation" : "original";
const same = (a: Token, b: Token) =>
  channel(a) === channel(b) &&
  a.speaker === b.speaker &&
  a.language === b.language;
/** Final deltas commit once. Provisional suffix is rebuilt, never appended.
 * Runs are independent: translated tokens have no 1:1 mapping to source tokens.
 * Only active runs are retained; sealed transcript history belongs to the session. */
export class Normalizer {
  private committed: Token[] = [];
  private next = 0;
  private previous = new Map<string, string>();
  private revisions = new Map<string, number>();
  private partialIds = new Set<string>();
  constructor(
    private target: string,
    private prefix: string,
  ) {}
  private segment(tokens: Token[], index: number, final: boolean): Segment {
    const first = tokens[0];
    const c = first ? channel(first) : "original";
    const text = tokens.map((t) => t.text).join("");
    return {
      id: `${this.prefix}-${index}`,
      revision: 0,
      final,
      original: c === "original" ? text : "",
      translated: c === "translation" ? text : "",
      channel: c,
      targetLanguage: this.target,
      speakerId: first?.speaker,
      sourceLanguage:
        c === "original" ? first?.language : first?.source_language,
      ...(c === "original"
        ? { startMs: first?.start_ms, endMs: tokens.at(-1)?.end_ms }
        : {}),
    };
  }
  private publish(segment: Segment): Segment[] {
    const signature = JSON.stringify(segment);
    if (this.previous.get(segment.id) === signature) return [];
    this.previous.set(segment.id, signature);
    segment.revision = (this.revisions.get(segment.id) ?? 0) + 1;
    this.revisions.set(segment.id, segment.revision);
    return [segment];
  }
  accept(raw: unknown): Segment[] {
    const data = responseSchema.parse(raw);
    const output: Segment[] = [];
    const sealed = new Set<string>();
    const provisional: Token[] = [];
    const seal = () => {
      if (!this.committed.length) return;
      const s = this.segment(this.committed, this.next, true);
      output.push(...this.publish(s));
      sealed.add(s.id);
      this.committed = [];
      this.next++;
    };
    for (const token of data.tokens) {
      if (!token.is_final) {
        if (token.text !== "<end>" && token.text !== "<fin>")
          provisional.push(token);
        continue;
      }
      if (token.text === "<end>" || token.text === "<fin>") {
        seal();
        continue;
      }
      const last = this.committed.at(-1);
      if (last && (!same(last, token) || this.committed.length >= 512)) seal();
      this.committed.push(token);
    }
    if (data.finished) seal();
    const groups: Token[][] = [];
    for (const token of [...this.committed, ...provisional]) {
      const last = groups.at(-1);
      if (last && same(last.at(-1)!, token)) last.push(token);
      else groups.push([token]);
    }
    const current = new Set<string>();
    groups.forEach((tokens, i) => {
      const s = this.segment(tokens, this.next + i, false);
      current.add(s.id);
      output.push(...this.publish(s));
    });
    for (const id of this.partialIds) {
      if (!current.has(id) && !sealed.has(id)) {
        const index = Number(id.split("-").at(-1));
        output.push(...this.publish(this.segment([], index, false)));
        this.previous.delete(id);
      }
    }
    for (const id of sealed) {
      this.previous.delete(id);
      this.revisions.delete(id);
    }
    this.partialIds = current;
    return output;
  }
}
