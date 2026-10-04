/** Scalar vitals from a Presage video job (no waveforms). */
export type PresageVitals = {
  heart_rate: number | null;
  breathing_rate: number | null;
  stress_index: number | null;
  stressed: boolean;
  focus_ok: boolean;
  source: "presage";
  raw_summary: string;
  /**
   * Explicit vendor face/quality signal when present.
   * `null`/omitted means "unknown" — empty scalars must not invent away.
   */
  face_detected?: boolean | null;
};
