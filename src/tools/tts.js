import { callChatCompletions } from "../aiRouter.js";
import { sendVoiceWithTranscript } from "../telegram.js";

export const definitions = [
  {
    type: "function",
    function: {
      name: "speak",
      description:
        "Convert text to a spoken voice message and send it DIRECTLY to the user (with the transcript in a collapsed/expandable quote below it). Do not repeat the text yourself in your own reply - the tool already delivers it.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to say." },
          voice: { type: "string", description: "Voice name, if you want something other than the default." },
        },
        required: ["text"],
      },
    },
  },
];

export async function execute(name, args, { env, chatId }) {
  if (name !== "speak") throw new Error(`unknown tts tool: ${name}`);

  const response = await callChatCompletions(env, {
    model: "auto",
    modalities: ["text", "audio"],
    audio: { voice: args.voice || "kore", format: "wav" },
    messages: [{ role: "user", content: args.text }],
  });

  const message = response.choices?.[0]?.message;
  const audioData = message?.audio?.data;
  if (!audioData) {
    throw new Error(`TTS response did not include audio data: ${JSON.stringify(response).slice(0, 300)}`);
  }
  const transcript = message?.audio?.transcript || message?.content || args.text;

  await sendVoiceWithTranscript(env, chatId, {
    audioBase64: audioData,
    mimeType: "audio/wav",
    transcript,
  });

  // IMPORTANT: only the transcript text goes back to the model / into
  // history - never the audio bytes. The user already received the audio
  // directly from Telegram above.
  return { ok: true, delivered: true, transcript };
}
