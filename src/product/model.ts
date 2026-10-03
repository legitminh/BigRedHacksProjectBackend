import { HttpError } from "../http.ts";

export const LEVELS = ["learning", "comfortable", "strong"] as const;
export type Level = (typeof LEVELS)[number];
export const MODES = ["advise", "pair", "ask"] as const;
export type Mode = (typeof MODES)[number];
export const TONES = ["brief", "explanatory"] as const;
export type Tone = (typeof TONES)[number];
export const INTERRUPTS = ["never", "sustained_only", "immediate"] as const;
export type Interrupt = (typeof INTERRUPTS)[number];
export const OUTCOMES = ["finished", "partial", "abandoned"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const ATTENTIONS = ["steady", "recovered", "dropped"] as const;
export type Attention = (typeof ATTENTIONS)[number];

export type Interaction = {
  tone: Tone;
  default_mode: Mode;
  interrupt: Interrupt;
  voice: boolean;
  check_in_minutes: number;
};

export const DEFAULT_INTERACTION: Interaction = {
  tone: "brief",
  default_mode: "advise",
  interrupt: "sustained_only",
  voice: true,
  check_in_minutes: 10,
};

export type Proficiency = { topic: string; level: Level };
export type PaceCard = { topic: string; median_minutes: number; samples: number };
export type MemoryCard = {
  interests: string[];
  proficiencies: Proficiency[];
  long_term_goals: string[];
  priorities: string[];
  pace: PaceCard[];
  interaction: Interaction;
  updated_at: string | null;
};

export type StoredProfile = {
  interests: string[];
  long_term_goals: string[];
  priorities: string[];
  interaction: Interaction;
  updated_at: string;
};

export type PaceSample = {
  id: string;
  topic: string;
  problem: string;
  planned_minutes: number;
  actual_minutes: number;
  outcome: Outcome;
  task_id: string | null;
  recorded_at: string;
};

export type TaskRecord = {
  id: string;
  title: string;
  mode: Mode;
  status: "active" | "done" | "dropped";
  planned_minutes: number;
  deadline_event_id: string | null;
  outcome: Outcome | null;
  started_at: string;
  ended_at: string | null;
};

export type SessionRecap = {
  id: string;
  task_id: string;
  started_at: string;
  ended_at: string;
  break_minutes: number;
  attention: Attention;
  note: string;
};

export type CalendarConnection = {
  connected: boolean;
  refreshToken: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "invalid_memory", "Expected a list of strings.");
  }
  if (value.length > cap) throw new HttpError(400, "memory_too_large", "That list is over the limit.");
  const seen = new Map<string, string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new HttpError(400, "invalid_memory", "List entries must be non-empty strings.");
    }
    const text = item.trim();
    seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()];
}

export function emptyMemory(): MemoryCard {
  return {
    interests: [],
    proficiencies: [],
    long_term_goals: [],
    priorities: [],
    pace: [],
    interaction: { ...DEFAULT_INTERACTION },
    updated_at: null,
  };
}

export function paceCards(samples: PaceSample[]): PaceCard[] {
  const finished = samples.filter((sample) => sample.outcome === "finished");
  const groups = new Map<string, PaceSample[]>();
  for (const sample of finished) {
    const key = sample.topic.toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(sample);
    groups.set(key, list);
  }
  const cards: PaceCard[] = [];
  for (const list of groups.values()) {
    const newest = [...list].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at));
    const window = newest.slice(0, 8);
    cards.push({
      topic: window[0]?.topic ?? newest[0]!.topic,
      median_minutes: median(window.map((sample) => sample.actual_minutes)),
      samples: window.length,
    });
  }
  cards.sort((a, b) => a.topic.localeCompare(b.topic));
  return cards;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

export function applyMemoryPut(
  current: StoredProfile | null,
  body: unknown,
  now: Date,
): StoredProfile {
  if (!isRecord(body)) throw new HttpError(400, "invalid_memory", "Expected a JSON object.");
  const base: StoredProfile = current ?? {
    interests: [],
    long_term_goals: [],
    priorities: [],
    interaction: { ...DEFAULT_INTERACTION },
    updated_at: now.toISOString(),
  };
  const next: StoredProfile = {
    interests: base.interests,
    long_term_goals: base.long_term_goals,
    priorities: base.priorities,
    interaction: { ...base.interaction },
    updated_at: now.toISOString(),
  };
  if ("interests" in body) next.interests = stringList(body.interests, 12);
  if ("long_term_goals" in body) next.long_term_goals = stringList(body.long_term_goals, 8);
  if ("priorities" in body) next.priorities = stringList(body.priorities, 8);
  if ("proficiencies" in body) parseProficiencyList(body.proficiencies);
  if ("interaction" in body) next.interaction = parseInteraction(body.interaction, next.interaction);
  return next;
}

export function parseProficiencyList(value: unknown): Proficiency[] {
  if (!Array.isArray(value)) throw new HttpError(400, "invalid_memory", "proficiencies must be a list.");
  if (value.length > 20) throw new HttpError(400, "memory_too_large", "That list is over the limit.");
  const seen = new Map<string, Proficiency>();
  for (const item of value) {
    if (!isRecord(item)) throw new HttpError(400, "invalid_memory", "Each proficiency needs a topic and level.");
    const topic = typeof item.topic === "string" ? item.topic.trim() : "";
    const level = oneOf(item.level, LEVELS);
    if (!topic || !level) throw new HttpError(400, "invalid_memory", "Each proficiency needs a topic and level.");
    seen.set(topic.toLowerCase(), { topic, level });
  }
  return [...seen.values()];
}

function parseInteraction(value: unknown, current: Interaction): Interaction {
  if (!isRecord(value)) throw new HttpError(400, "invalid_memory", "interaction must be an object.");
  const next = { ...current };
  if ("tone" in value) {
    const tone = oneOf(value.tone, TONES);
    if (!tone) throw new HttpError(400, "invalid_memory", "tone must be brief or explanatory.");
    next.tone = tone;
  }
  if ("default_mode" in value) {
    const mode = oneOf(value.default_mode, MODES);
    if (!mode) throw new HttpError(400, "invalid_memory", "default_mode must be advise, pair, or ask.");
    next.default_mode = mode;
  }
  if ("interrupt" in value) {
    const interrupt = oneOf(value.interrupt, INTERRUPTS);
    if (!interrupt) throw new HttpError(400, "invalid_memory", "interrupt is not a known setting.");
    next.interrupt = interrupt;
  }
  if ("voice" in value) {
    if (typeof value.voice !== "boolean") throw new HttpError(400, "invalid_memory", "voice must be true or false.");
    next.voice = value.voice;
  }
  if ("check_in_minutes" in value) {
    if (!Number.isInteger(value.check_in_minutes) || (value.check_in_minutes as number) < 1 || (value.check_in_minutes as number) > 180) {
      throw new HttpError(400, "invalid_memory", "check_in_minutes must be an integer from 1 to 180.");
    }
    next.check_in_minutes = value.check_in_minutes as number;
  }
  return next;
}

export function stepProficiency(current: Level | null, requested: unknown): Level {
  const level = oneOf(requested, LEVELS);
  if (!level) throw new HttpError(400, "invalid_memory", "level must be learning, comfortable, or strong.");
  const from = current === null ? -1 : LEVELS.indexOf(current);
  const to = LEVELS.indexOf(level);
  if (Math.abs(to - from) !== 1) {
    throw new HttpError(409, "proficiency_step", "Proficiency can only move one step at a time.");
  }
  return level;
}

export function parsePaceInput(body: unknown): {
  topic: string;
  problem: string;
  planned_minutes: number;
  actual_minutes: number;
  outcome: Outcome;
  task_id: string | null;
} {
  if (!isRecord(body)) throw new HttpError(400, "invalid_pace", "Expected a JSON object.");
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  const problem = typeof body.problem === "string" ? body.problem.trim() : "";
  const outcome = oneOf(body.outcome, OUTCOMES);
  if (!topic || !problem || !outcome) {
    throw new HttpError(400, "invalid_pace", "topic, problem, and outcome are required.");
  }
  return {
    topic,
    problem,
    planned_minutes: minutes(body.planned_minutes, "planned_minutes"),
    actual_minutes: minutes(body.actual_minutes, "actual_minutes"),
    outcome,
    task_id: optionalId(body.task_id),
  };
}

function minutes(value: unknown, name: string, code = "invalid_pace"): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 240) {
    throw new HttpError(400, code, `${name} must be an integer from 1 to 240.`);
  }
  return value as number;
}

function optionalId(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "invalid_pace", "task_id must be a string.");
  }
  return value.trim();
}

export function parseTaskCreate(body: unknown): {
  title: string;
  mode: Mode;
  planned_minutes: number;
  deadline_event_id: string | null;
} {
  if (!isRecord(body)) throw new HttpError(400, "invalid_task", "Expected a JSON object.");
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const mode = oneOf(body.mode, MODES);
  if (!title || title.length > 200 || !mode) {
    throw new HttpError(400, "invalid_task", "title and mode are required.");
  }
  let deadline: string | null = null;
  if (body.deadline_event_id !== undefined && body.deadline_event_id !== null) {
    if (typeof body.deadline_event_id !== "string" || body.deadline_event_id.trim().length === 0) {
      throw new HttpError(400, "invalid_task", "deadline_event_id must be a string.");
    }
    deadline = body.deadline_event_id.trim();
  }
  return {
    title,
    mode,
    planned_minutes: minutes(body.planned_minutes, "planned_minutes", "invalid_task"),
    deadline_event_id: deadline,
  };
}

export function parseTaskPatch(body: unknown, current: TaskRecord): TaskRecord {
  if (!isRecord(body)) throw new HttpError(400, "invalid_task", "Expected a JSON object.");
  const next = { ...current };
  if ("title" in body) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 200) throw new HttpError(400, "invalid_task", "title is required.");
    next.title = title;
  }
  if ("mode" in body) {
    const mode = oneOf(body.mode, MODES);
    if (!mode) throw new HttpError(400, "invalid_task", "mode must be advise, pair, or ask.");
    next.mode = mode;
  }
  if ("planned_minutes" in body) {
    next.planned_minutes = minutes(body.planned_minutes, "planned_minutes", "invalid_task");
  }
  return next;
}

export function parseComplete(body: unknown): { outcome: Outcome; topic: string; break_minutes: number } {
  if (!isRecord(body)) throw new HttpError(400, "invalid_task", "Expected a JSON object.");
  const outcome = oneOf(body.outcome, OUTCOMES);
  const topic = typeof body.topic === "string" ? body.topic.trim() : "";
  if (!outcome || !topic) throw new HttpError(400, "invalid_task", "outcome and topic are required.");
  const breakMinutes = body.break_minutes === undefined ? 0 : body.break_minutes;
  if (!Number.isInteger(breakMinutes) || (breakMinutes as number) < 0 || (breakMinutes as number) > 240) {
    throw new HttpError(400, "invalid_task", "break_minutes must be an integer from 0 to 240.");
  }
  return { outcome, topic, break_minutes: breakMinutes as number };
}

export function actualMinutes(startedAt: string, now: Date, breakMinutes: number): number {
  const elapsed = Math.round((now.getTime() - Date.parse(startedAt)) / 60000) - breakMinutes;
  return Math.min(240, Math.max(1, elapsed));
}

export function parseSession(body: unknown): Omit<SessionRecap, "id"> {
  if (!isRecord(body)) throw new HttpError(400, "invalid_session", "Expected a JSON object.");
  const taskId = typeof body.task_id === "string" ? body.task_id.trim() : "";
  const attention = oneOf(body.attention, ATTENTIONS);
  const note = typeof body.note === "string" ? body.note : null;
  if (!taskId || !attention || note === null || note.length > 4000) {
    throw new HttpError(400, "invalid_session", "task_id, attention, and note are required.");
  }
  const started = typeof body.started_at === "string" ? Date.parse(body.started_at) : Number.NaN;
  const ended = typeof body.ended_at === "string" ? Date.parse(body.ended_at) : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    throw new HttpError(400, "invalid_session", "started_at and ended_at must be timestamps.");
  }
  const breakMinutes = body.break_minutes === undefined ? 0 : body.break_minutes;
  if (!Number.isInteger(breakMinutes) || (breakMinutes as number) < 0) {
    throw new HttpError(400, "invalid_session", "break_minutes must be a non-negative integer.");
  }
  return {
    task_id: taskId,
    started_at: new Date(started).toISOString(),
    ended_at: new Date(ended).toISOString(),
    break_minutes: breakMinutes as number,
    attention,
    note,
  };
}
