import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
	TranscriptionModelId,
} from "@/transcription/types";

/**
 * OpenCut transcribes in the browser with a speech model it downloads from
 * Hugging Face on first use. Autora does not reach out for models (it works
 * offline, and nothing leaves the machine unasked), so captions from speech are
 * not part of this window; the person can type subtitles as text clips, and the
 * agent can add them (video_text). Said plainly rather than failing in a worker.
 */
class TranscriptionService {
	async transcribe(_args: {
		audioData: Float32Array;
		language?: TranscriptionLanguage;
		modelId?: TranscriptionModelId;
		onProgress?: (progress: TranscriptionProgress) => void;
	}): Promise<TranscriptionResult> {
		throw new Error("Automatic captions are not available in Autora Video. Ask the agent to add the subtitles as text.");
	}
}

export const transcriptionService = new TranscriptionService();
