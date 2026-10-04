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

/** Desktop local Vision (and brightness) posted with observe. */
export type ClientObserveMeta = {
  brightness?: number | null;
  brightness_measured?: boolean;
  /** Local Apple Vision majority face — PRIMARY for desk-away when boolean. */
  face_detected?: boolean | null;
  /** `"present"` | `"absent"` | `"looking_down"` | `"looking_away"` */
  attention?: string | null;
  /**
   * Kind of the last camera nudge the desktop successfully delivered (push/speak).
   * Server consumes a pending ladder rung only after this matches.
   */
  last_nudge_ack?: string | null;
};
