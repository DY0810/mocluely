import { GoogleGenAI } from '@google/genai';

export class LLMService {
    private ai: GoogleGenAI;
    private modelStr: string;

    constructor(apiKey: string, modelStr: string) {
        this.ai = new GoogleGenAI({ apiKey });
        this.modelStr = modelStr;
    }

    /**
     * Stream interview assistance based on a screenshot and audio transcript.
     * Yields text chunks as they arrive from the model.
     */
    async *streamInterviewHelp(
        base64Image: string | null,
        audioChunk: { data: string; mimeType: string } | null,
        systemPrompt: string
    ): AsyncGenerator<string> {
        try {
            // FILTER: We only want to answer if there's an actual question or actionable problem
            let filterPrompt = '';

            if (base64Image && audioChunk) {
                filterPrompt = `Here is the current screen and the live audio segment from the interviewer/user. Analyze the screen and listen to the audio carefully. FIRST, decide if there is a clear, actionable coding problem, question, or request for help present in the audio or visible on the screen. If there is NOT, or if the audio is mostly silence/background noise, output EXACTLY the word "NO_ACTION" and nothing else. Do NOT hallucinate a coding problem. If there IS a question, you MUST format your output exactly like this:\n\n**Q: [State the detected question or problem here]**\n\n[Your concise actionable hints or full solution here]\n\nUse markdown formatting.`;
            } else if (base64Image) {
                filterPrompt = `Here is the current screen. The user hasn't spoken yet or there's no audio available. Analyze the screen content. If there is no clear actionable coding problem visible, output EXACTLY the word "NO_ACTION". Do NOT hallucinate a coding problem. If there IS a problem, you MUST format your output exactly like this:\n\n**Q: [State the detected problem from the screen here]**\n\n[Your concise actionable hints or full solution here]\n\nUse markdown formatting.`;
            } else if (audioChunk) {
                filterPrompt = `Here is the live audio segment from the interviewer/user. There is no screen visible right now. Listen to the audio carefully. FIRST, decide if there is a clear, actionable coding problem, question, or request for help present in the audio. If the audio is mostly silence, background noise, or casual conversation, output EXACTLY the word "NO_ACTION" and nothing else. Do NOT hallucinate a coding problem if one is not clearly asked. If there IS a question, you MUST format your output exactly like this:\n\n**Q: [State the detected question here]**\n\n[Your concise actionable hints or full solution here]\n\nUse markdown formatting.`;
            }

            const parts: any[] = [{ text: filterPrompt }];

            if (base64Image) {
                parts.push({ inlineData: { data: base64Image, mimeType: 'image/png' } });
            }

            if (audioChunk) {
                parts.push({ inlineData: { data: audioChunk.data, mimeType: audioChunk.mimeType } });
            }

            const responseStream = await this.ai.models.generateContentStream({
                model: this.modelStr,
                contents: [{ role: 'user', parts: parts }],
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.2,
                }
            });

            for await (const chunk of responseStream) {
                if (chunk.text) {
                    yield chunk.text;
                }
            }
        } catch (e) {
            console.error("LLM streaming error:", e);
            yield `\n\n**Error:** ${(e as Error).message || 'Failed to analyze screen.'}`;
        }
    }
}
