/// <reference types="dom-speech-recognition" />

let audioStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let audioMimeType = '';
let onQuestionReadyGlobal: ((audio: { data: string, mimeType: string }) => void) | null = null;
let lastRecorderStartTime = 0;
let isFlushing = false;

// Voice Activity Detection (VAD) state
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let detectionInterval: any = null;
let isSpeaking = false;
let silenceStartTimer: number | null = null;
let firstSpeakingTime: number | null = null;

const SILENCE_THRESHOLD_DB = 10; // Threshold above background noise to count as "speaking"
const SILENCE_DURATION_MS = 1500; // 1.5 seconds of silence means you finished your question

export async function startCaptureServices(
    onStatusUpdate: (text: string) => void,
    onQuestionReady: (audio: { data: string, mimeType: string }) => void
) {
    onQuestionReadyGlobal = onQuestionReady;
    try {
        // Native Microphone Capture for direct processing
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(audioStream);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

        mediaRecorder.start(250); // fast chunks to easily build blobs when triggered
        lastRecorderStartTime = Date.now();

        // Clean mimeType (Gemini hates "audio/webm;codecs=opus", needs strict "audio/webm")
        const rawMimeType = mediaRecorder.mimeType || 'audio/webm';
        audioMimeType = rawMimeType.split(';')[0];

        // --- Setup Silence Detection (Voice Activity) ---
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(audioStream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        detectionInterval = setInterval(async () => {
            if (!analyser || mediaRecorder?.state === 'paused') return;

            analyser.getByteFrequencyData(dataArray);
            let maxVolume = 0;
            for (let i = 0; i < dataArray.length; i++) {
                if (dataArray[i] > maxVolume) maxVolume = dataArray[i];
            }

            // Fixed Threshold: 30 is generally above computer fan/room noise, but easily crossed by speaking.
            const speakingThreshold = 30;

            if (maxVolume > speakingThreshold) {
                // User is actively speaking
                if (!isSpeaking) {
                    isSpeaking = true;
                    firstSpeakingTime = Date.now();
                    onStatusUpdate("🎙️ Speaking detected...");
                }
                silenceStartTimer = null; // reset silence timer
            } else {
                // User is quiet
                if (isSpeaking) {
                    if (silenceStartTimer === null) {
                        silenceStartTimer = Date.now();
                        onStatusUpdate("⏸️ Silence... waiting " + (SILENCE_DURATION_MS / 1000) + "s...");
                    } else if (Date.now() - silenceStartTimer > SILENCE_DURATION_MS) {
                        // user has been silent for 1.5s -> Trigger formulation!
                        isSpeaking = false;

                        const actualSpeechDuration = silenceStartTimer - (firstSpeakingTime || silenceStartTimer);
                        silenceStartTimer = null;
                        firstSpeakingTime = null;

                        if (actualSpeechDuration < 400) {
                            // Under 400ms of noise. Probably a sniff, cough, or desk bump.
                            onStatusUpdate("🔴 Ignoring short noise...");
                            flushRecorder(false);
                            setTimeout(() => { if (!isSpeaking) onStatusUpdate("🔴 Listening for speech..."); }, 1000);
                        } else {
                            onStatusUpdate("⚡ Processing question...");
                            flushRecorder(true);
                        }
                    }
                } else {
                    // Prevent memory infinitely growing in total silence
                    if (Date.now() - lastRecorderStartTime > 5000) {
                        flushRecorder(false);
                    }
                    if (Math.random() < 0.05) onStatusUpdate("🔴 Listening for speech...");
                }
            }
        }, 100);

        onStatusUpdate("🔴 Listening for speech...");
    } catch (err) {
        console.error("Failed to start capture:", err);
        throw err;
    }
}

export function pauseAudioCapture(): void {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
    }
}

export function clearAudioBuffer(): void {
    audioChunks = [];
    isSpeaking = false;
    silenceStartTimer = null;
    firstSpeakingTime = null;
}

export function resumeAudioCapture(): void {
    if (mediaRecorder && mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
        flushRecorder(false); // cleanly wipe and start fresh without dropping headers
    }
}

/**
 * Cleanly stops and restarts the MediaRecorder to guarantee a perfectly valid
 * WebM file with proper headers, rather than corrupting chunks via slicing.
 */
async function flushRecorder(sendToLLM: boolean): Promise<void> {
    if (!mediaRecorder || isFlushing || mediaRecorder.state !== 'recording') return;
    isFlushing = true;

    return new Promise((resolve) => {
        mediaRecorder!.onstop = () => {
            const chunksToProcess = [...audioChunks];
            audioChunks = [];

            if (sendToLLM && chunksToProcess.length > 0 && onQuestionReadyGlobal) {
                console.log(`[VAD] Flushing ${chunksToProcess.length} perfectly valid chunks to Blob encoder...`);
                const blob = new Blob(chunksToProcess, { type: audioMimeType });

                const reader = new FileReader();
                reader.onloadend = () => {
                    const result = reader.result as string;
                    onQuestionReadyGlobal!({
                        data: result.split(',')[1],
                        mimeType: audioMimeType
                    });
                };
                reader.readAsDataURL(blob);
            }

            if (audioStream && mediaRecorder) {
                try {
                    mediaRecorder.start(250);
                    lastRecorderStartTime = Date.now();
                } catch (e) {
                    console.error("Failed to restart recorder", e);
                }
            }

            isFlushing = false;
            resolve();
        };

        mediaRecorder!.stop();
    });
}

export async function captureScreenOnDemand(): Promise<string | null> {
    try {
        // Ping main process to snag a high-res thumbnail instantly
        return await (window as any).ipcRenderer.invoke('capture-screen-on-demand');
    } catch (e) {
        console.error("IPC capture failed:", e);
        return null;
    }
}

export function stopCaptureServices(): void {
    let needsFinalFlush = false;
    if (firstSpeakingTime !== null) {
        const speechEnd = silenceStartTimer || Date.now();
        if (speechEnd - firstSpeakingTime >= 400) {
            needsFinalFlush = true;
        }
    }

    if (detectionInterval) {
        clearInterval(detectionInterval);
        detectionInterval = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (mediaRecorder) {
        if (needsFinalFlush && mediaRecorder.state === 'recording') {
            // Process the final unhandled speech chunk
            mediaRecorder.onstop = () => {
                const chunksToProcess = [...audioChunks];
                audioChunks = [];
                if (chunksToProcess.length > 0 && onQuestionReadyGlobal) {
                    console.log(`[VAD] Final flush triggered on Stop Capture...`);
                    const blob = new Blob(chunksToProcess, { type: audioMimeType });
                    const reader = new FileReader();
                    reader.onloadend = () => {
                        const result = reader.result as string;
                        onQuestionReadyGlobal!({
                            data: result.split(',')[1],
                            mimeType: audioMimeType
                        });
                    };
                    reader.readAsDataURL(blob);
                }
            };
        } else {
            mediaRecorder.onstop = null;
        }

        if (mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        mediaRecorder = null;
    }
    if (audioStream) {
        audioStream.getTracks().forEach(t => t.stop());
        audioStream = null;
    }

    isSpeaking = false;
    silenceStartTimer = null;
    firstSpeakingTime = null;
    isFlushing = false;
}
