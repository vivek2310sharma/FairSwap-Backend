// supabase/functions/_shared/openai-moderation-adapter.ts
// Direct OpenAI Moderation API adapter for Supabase Edge worker.
// Evaluates listing text and image URLs against omni-moderation-latest.

export interface OpenAiModerationInput {
  text: string;
  imageUrls?: string[];
  apiKey: string;
  apiBase?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface OpenAiModerationResult {
  completed: boolean;
  flagged: boolean;
  model: string;
  flags: Array<{
    category: string;
    score: number;
  }>;
  error?: string;
}

export async function evaluateOpenAiModeration(
  input: OpenAiModerationInput
): Promise<OpenAiModerationResult> {
  const fetchFn = input.fetcher || fetch;
  const apiBase = input.apiBase || "https://api.openai.com/v1";
  const timeoutMs = input.timeoutMs || 8000;
  const model = "omni-moderation-latest";

  const multimodalInputs: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    { type: "text", text: input.text },
  ];

  for (const url of input.imageUrls || []) {
    multimodalInputs.push({
      type: "image_url",
      image_url: { url },
    });
  }

  try {
    const res = await fetchFn(`${apiBase}/moderations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        input: multimodalInputs,
        model,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return {
        completed: false,
        flagged: false,
        model,
        error: `OPENAI_HTTP_${res.status}`,
        flags: [],
      };
    }

    const data = await res.json();
    if (!data || !Array.isArray(data.results) || data.results.length === 0) {
      return {
        completed: false,
        flagged: false,
        model,
        error: "OPENAI_INVALID_RESPONSE_SHAPE",
        flags: [],
      };
    }

    let isFlagged = false;
    const flags: Array<{ category: string; score: number }> = [];

    for (const item of data.results) {
      if (item.flagged) {
        isFlagged = true;
      }
      if (item.categories && typeof item.categories === "object") {
        for (const [cat, flaggedVal] of Object.entries(item.categories)) {
          if (flaggedVal === true) {
            const score = item.category_scores?.[cat] || 1.0;
            flags.push({ category: cat, score });
          }
        }
      }
    }

    return {
      completed: true,
      flagged: isFlagged,
      model: (typeof data.model === "string" ? data.model : model),
      flags,
    };
  } catch (err: any) {
    return {
      completed: false,
      flagged: false,
      model,
      error: `OPENAI_REQUEST_FAILED: ${err?.message || "TIMEOUT"}`,
      flags: [],
    };
  }
}

