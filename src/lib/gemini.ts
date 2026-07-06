import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ChatTurn } from "./claude";

// gemini-3.5-flash: cost-efficient, fast, great for structured text generation
export const GEMINI_MODEL = "gemini-3.5-flash";
const MAX_HISTORY_TURNS = 6; // mirrors claude.ts budget

export function getGeminiClient(apiKey: string): GoogleGenerativeAI {
    return new GoogleGenerativeAI(apiKey);
}

/**
 * Stream a reply from Gemini. Has the same AsyncGenerator<string> interface as
 * streamReply() in claude.ts so sidepanel.ts can swap providers transparently.
 *
 * Expects `history` to end with the current user turn (same convention as the
 * Anthropic wrapper — the caller pushes the user turn before calling this).
 */
export async function* streamReplyGemini(
    client: GoogleGenerativeAI,
    system: string,
    history: ChatTurn[],
    signal?: AbortSignal,
): AsyncGenerator<string> {
    const trimmed =
        history.length > MAX_HISTORY_TURNS
            ? history.slice(history.length - MAX_HISTORY_TURNS)
            : history;

    // Split: all turns before the last one become chat history; the last user
    // message is sent via sendMessageStream.
    const lastTurn = trimmed.at(-1);
    const priorTurns = trimmed.slice(0, -1);
    const lastUserMsg = lastTurn?.content ?? "";

    const geminiHistory = priorTurns.map((t) => ({
        role: t.role === "assistant" ? "model" : "user",
        parts: [{ text: t.content }],
    }));

    const model = client.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: system,
        generationConfig: { maxOutputTokens: 1400 },
    });

    const chat = model.startChat({ history: geminiHistory });
    const result = await chat.sendMessageStream(lastUserMsg, { signal });

    for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
    }
}
