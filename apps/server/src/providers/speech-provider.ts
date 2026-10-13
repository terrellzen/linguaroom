import type { Start, Segment } from "../../../../packages/shared/protocol.js";
export interface SpeechStream {
  audio(data: Buffer): boolean;
  end(): Promise<void>;
}
export interface ProviderCallbacks {
  segment(segment: Segment): void;
  state(state: string): void;
  error(message: string): void;
  usage(metrics: Record<string, number>): void;
}
export interface SpeechProvider {
  readonly id: string;
  capabilities(): {
    translation: boolean;
    diarization: boolean;
    languages: readonly string[];
  };
  initialize(): Promise<void>;
  create(
    key: string,
    options: Start,
    callbacks: ProviderCallbacks,
  ): Promise<SpeechStream>;
}
