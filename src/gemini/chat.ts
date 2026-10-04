import { HttpError } from "../http.ts";
import type { FetchLike } from "./ephemeral.ts";

export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

export async function geminiChat(input: {
  apiKey: string;
  model: string;
  system: string;
  history: ChatTurn[];
  message: string;
  fetchImpl: FetchLike;
}): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`;
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
  for (const turn of input.history) {
    if (turn.role === "system") continue;
    contents.push({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.content }],
    });
  }
  contents.push({ role: "user", parts: [{ text: input.message }] });

  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: input.system }] },
        contents,
        generationConfig: { temperature: 0.4 },
      }),
    });
  } catch {
    throw new HttpError(502, "gemini_unreachable", "Could not reach Gemini.");
  }

  const payload = (await response.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string; status?: string };
  } | null;

  if (!response.ok) {
    const msg = payload?.error?.message ?? `HTTP ${response.status}`;
    console.warn("Gemini REST chat failure:", response.status, String(msg).slice(0, 300));
    if (
      response.status === 429 ||
      payload?.error?.status === "RESOURCE_EXHAUSTED" ||
      /resource.exhausted|\bquota\b/i.test(msg)
    ) {
      throw new HttpError(
        429,
        "gemini_quota",
        "Cloud coach hit today’s free limit. Try again tomorrow, or keep using local lock-in coaching.",
      );
    }
    throw new HttpError(502, "gemini_failed", msg);
  }

  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) {
    throw new HttpError(502, "gemini_empty", "Gemini returned an empty reply.");
  }
  return text;
}
