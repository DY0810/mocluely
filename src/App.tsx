import { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, EyeOff, Play, Square, Save, Mic, Trash2, Power, Camera } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { startCaptureServices, stopCaptureServices, captureScreenOnDemand, pauseAudioCapture, resumeAudioCapture } from './capture';
import { LLMService } from './llm';

const DEFAULT_SYSTEM_PROMPT = `You are a world-class coding interview assistant. You are invisible to the interviewer. Your goal is to stealthily help the user pass top-tier tech interviews.
Listen strictly to the context and intent of the interviewer's words.
- Provide direct, flawless coding solutions, but ALSO include high-level technical explanations to help the user speak articulately.
- If asked a behavioral or theoretical question, provide bulleted talking points and conceptual answers.
- Frame your answers so the user sounds confident and communicative.
- Do NOT hallucinate questions; wait for a clear problem.
Be extremely concise. Use markdown formatting with clear code blocks.`;

function App() {
    const [showSettings, setShowSettings] = useState(false);
    const [isCapturing, setIsCapturing] = useState(false);
    const [apiKey, setApiKey] = useState(() => localStorage.getItem('mocluely-api-key') || '');
    const [model, setModel] = useState(() => localStorage.getItem('mocluely-model') || 'gemini-3-flash-preview');
    const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('mocluely-system-prompt') || DEFAULT_SYSTEM_PROMPT);
    const [audioStatus, setAudioStatus] = useState('');
    const [isAnswering, setIsAnswering] = useState(false);
    const [isGhostMode, setIsGhostMode] = useState(false);

    const [suggestions, setSuggestions] = useState<Array<{ id: string; text: string }>>([]);

    const contentAreaRef = useRef<HTMLDivElement>(null);
    const isProcessingRef = useRef(false); // Brutal lock for concurrent API streams
    const isCapturingRef = useRef(false);
    const runAILoopRef = useRef<Function | null>(null);

    const toggleCapture = useCallback(async () => {
        if (!apiKey) {
            setShowSettings(true);
            setAudioStatus("⚠️ Please enter an API Key in Settings first.");
            return;
        }

        if (isCapturingRef.current) {
            setIsCapturing(false);
            isCapturingRef.current = false;
            stopCaptureServices();
        } else {
            try {
                await startCaptureServices(
                    (status) => setAudioStatus(status),
                    (audioChunk) => {
                        if (runAILoopRef.current) runAILoopRef.current(audioChunk);
                    }
                );
                setIsCapturing(true);
                isCapturingRef.current = true;
                setSuggestions(prev => [
                    ...prev,
                    { id: 'started-' + Date.now(), text: '🟢 **Capture started.** Listening for questions...' },
                ]);
            } catch (e) {
                setSuggestions(prev => [
                    ...prev,
                    { id: 'error-' + Date.now(), text: `**❌ Capture Error:**\n\`\`\`\n${e}\n\`\`\`` },
                ]);
            }
        }
    }, [isCapturing, apiKey, model, systemPrompt, isAnswering]);

    const clearSuggestions = () => setSuggestions([]);

    // ─── AI Analysis Trigger (Voice Activity Detected) ───
    const runAILoop = async (audioChunk: { data: string, mimeType: string }) => {
        // Brutal explicit lock: Prevent starting a second LLM request if one is currently processing
        // (This protects against answering a second trigger during the 2s Gemini network delay!)
        if (isProcessingRef.current || isAnswering) return;
        isProcessingRef.current = true;

        const llm = new LLMService(apiKey, model);
        const sid = Date.now().toString();

        try {
            const stream = llm.streamInterviewHelp(null, audioChunk, systemPrompt);
            let fullText = '';
            let hasStartedAnswering = false;

            console.log(`[LLM] Starting new interview stream. audioSize: ${audioChunk.data.length} bytes`);

            for await (const chunk of stream) {
                fullText += chunk;
                const trimmedText = fullText.trim();

                console.log(`[LLM] Received chunk: "${chunk}". Total text: ${fullText.length} chars. trimmedText: "${trimmedText}"`);

                if (trimmedText === 'NO_ACTION') {
                    console.log("[LLM] Stream hit NO_ACTION identically. Locking false and killing stream.");
                    isProcessingRef.current = false; // Release the lock cleanly

                    setSuggestions(prev =>
                        prev.map(s => (s.id === sid ? { ...s, text: `*No coding question detected in the last audio snippet.*` } : s))
                    );
                    break;
                }

                if ('NO_ACTION'.startsWith(trimmedText)) {
                    console.log("[LLM] Stream starts with NO_ACTION... ignoring token.");
                    continue;
                }

                // Once we actually start getting answer tokens instead of NO_ACTION, pause listening
                if (!hasStartedAnswering) {
                    console.log("[LLM] First actual answer token received! Pausing mic...");
                    hasStartedAnswering = true;
                    setIsAnswering(true);
                    pauseAudioCapture();

                    setSuggestions(prev =>
                        [...prev, { id: sid, text: '⏳ *Analyzing live audio...*' }]
                    );
                }

                setSuggestions(prev =>
                    prev.map(s => (s.id === sid ? { ...s, text: fullText } : s))
                );
            }

            console.log(`[LLM] Stream finished. Total length: ${fullText.length}`);

            if (hasStartedAnswering) {
                setIsAnswering(false);
                resumeAudioCapture();
            } else if (fullText.length > 0 && !fullText.includes("NO_ACTION")) {
                // Failsafe: if we got text but it never hit the answering flag
                setSuggestions(prev => [...prev, { id: sid, text: fullText }]);
            }

        } catch (e: any) {
            setSuggestions(prev =>
                prev.map(s =>
                    s.id === sid ? { ...s, text: `**❌ LLM Error:** ${e.message}` } : s
                )
            );
            setIsAnswering(false);
            resumeAudioCapture();
        } finally {
            isProcessingRef.current = false; // ALWAYS release the lock
        }
    };

    runAILoopRef.current = runAILoop;

    // ─── On-Demand Screen Analysis ───
    const analyzeScreenNow = useCallback(async () => {
        if (!apiKey) {
            setShowSettings(true);
            return;
        }

        if (isProcessingRef.current) {
            setSuggestions(prev => [{ id: 'err-' + Date.now(), text: '❌ Please wait for the current analysis to finish.' }, ...prev]);
            return;
        }

        isProcessingRef.current = true;
        const sid = 'screen-' + Date.now().toString();
        setSuggestions(prev => [...prev, { id: sid, text: '📸 *Snapping screen and passing to LLM...*' }]);

        const frame = await captureScreenOnDemand();
        if (!frame) {
            setSuggestions(prev => prev.map(s => s.id === sid ? { ...s, text: '❌ Failed to capture screen.' } : s));
            return;
        }

        // For manual screen capture, we don't bundle audio to avoid mixing contexts. Only screen is sent.
        const audioChunk = null;
        const llm = new LLMService(apiKey, model);

        try {
            const stream = llm.streamInterviewHelp(frame, audioChunk, systemPrompt);
            let fullText = '';

            setIsAnswering(true);
            pauseAudioCapture();

            for await (const chunk of stream) {
                fullText += chunk;

                if (fullText.trim() === 'NO_ACTION') {
                    setSuggestions(prev => prev.map(s => (s.id === sid ? { ...s, text: "No actionable problem found on screen." } : s)));
                    break;
                }

                setSuggestions(prev => prev.map(s => (s.id === sid ? { ...s, text: fullText } : s)));
            }

            setIsAnswering(false);
            resumeAudioCapture();
        } catch (e: any) {
            setIsAnswering(false);
            resumeAudioCapture();
            setSuggestions(prev => prev.map(s => (s.id === sid ? { ...s, text: `**❌ LLM Error:** ${e.message}` } : s)));
        } finally {
            isProcessingRef.current = false;
        }
    }, [isCapturing, apiKey, model, systemPrompt]);

    // Listen for Global Shortcut (Cmd+Shift+S)
    useEffect(() => {
        const handler = () => analyzeScreenNow();
        (window as any).ipcRenderer.on('trigger-screen-analysis', handler);
        return () => (window as any).ipcRenderer.off('trigger-screen-analysis', handler);
    }, [analyzeScreenNow]);

    // Fetch initial Ghost Mode and listen for toggles
    useEffect(() => {
        (window as any).ipcRenderer.invoke('get-ghost-mode').then((mode: boolean) => {
            setIsGhostMode(mode);
        });

        const ghostHandler = (_event: any, mode: boolean) => {
            setIsGhostMode(mode);
        };
        (window as any).ipcRenderer.on('ghost-mode-toggled', ghostHandler);

        return () => (window as any).ipcRenderer.off('ghost-mode-toggled', ghostHandler);
    }, []);

    return (
        <div className="glass-panel">
            {/* ── Header ── */}
            <div className="drag-header">
                <div className="title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <EyeOff size={15} color="var(--accent)" />
                    MoCluely

                    {isGhostMode && (
                        <span style={{ fontSize: '13px', marginLeft: '2px' }} title="Ghost Mode (Click-Through)">
                            👻
                        </span>
                    )}

                    {/* Top Status Indicator */}
                    {isCapturing && (
                        <span style={{ fontSize: '11px', fontWeight: 500, color: isAnswering ? 'var(--warning)' : 'var(--danger)' }}>
                            {isAnswering ? '⏸️ Paused (Answering)' : '🔴 Listening'}
                        </span>
                    )}
                </div>
                <div className="buttons">
                    <button className="icon-btn" onClick={clearSuggestions} title="Clear">
                        <Trash2 size={14} />
                    </button>
                    <button
                        className="icon-btn"
                        onClick={() => setShowSettings(!showSettings)}
                        title="Settings"
                    >
                        <Settings size={15} />
                    </button>
                    <button
                        className="icon-btn"
                        onClick={() => (window as any).ipcRenderer.send('quit-app')}
                        title="Quit App"
                    >
                        <Power size={15} color="var(--danger)" />
                    </button>
                </div>
            </div>

            {/* ── Content ── */}
            <div className="content-area" ref={contentAreaRef}>
                {showSettings ? (
                    <div className="settings-panel">
                        <h3 style={{ color: 'var(--text-main)', fontSize: '15px', fontWeight: 600 }}>
                            ⚙️ Configuration
                        </h3>

                        <div className="input-group">
                            <label className="input-label">Gemini API Key</label>
                            <input
                                type="password"
                                className="input-field"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                placeholder="AIzaSy..."
                            />
                        </div>

                        <div className="input-group">
                            <label className="input-label">Model</label>
                            <input
                                type="text"
                                className="input-field"
                                value={model}
                                onChange={(e) => setModel(e.target.value)}
                            />
                        </div>

                        <div className="input-group">
                            <label className="input-label">System Prompt</label>
                            <textarea
                                className="input-field"
                                value={systemPrompt}
                                onChange={(e) => setSystemPrompt(e.target.value)}
                                rows={5}
                            />
                        </div>

                        <div style={{ marginTop: '8px', padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                            <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', lineHeight: '1.4' }}>
                                💡 **For new users:** Get your free Gemini API Key at <span style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }} onClick={() => window.open('https://aistudio.google.com/app/apikey', '_blank')}>Google AI Studio</span>.
                            </p>
                            <p style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.4' }}>
                                🔒 **macOS Permissions:** Check **Privacy & Security** in System Settings for **Microphone** and **Screen Recording** access.
                            </p>
                        </div>

                        <button
                            className="primary-btn"
                            onClick={() => {
                                localStorage.setItem('mocluely-api-key', apiKey);
                                localStorage.setItem('mocluely-model', model);
                                localStorage.setItem('mocluely-system-prompt', systemPrompt);
                                setShowSettings(false);
                            }}
                            style={{ marginTop: '4px' }}
                        >
                            <Save size={15} /> Save & Close
                        </button>
                    </div>
                ) : (
                    <>
                        {suggestions.length === 0 && (
                            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '32px 0' }}>
                                Start capture, then begin speaking to see answers here.
                            </div>
                        )}
                        {suggestions.map((sug) => (
                            <div key={sug.id} className="suggestion-card">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{sug.text}</ReactMarkdown>
                            </div>
                        ))}
                    </>
                )}
            </div>

            {/* ── Footer ── */}
            <div className="footer">
                <div className="transcript-preview">
                    <Mic size={12} />
                    {audioStatus || 'Ready to capture audio...'}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                        className={`primary-btn ${isCapturing ? 'capture-btn-active' : ''}`}
                        style={{ flex: 1 }}
                        onClick={toggleCapture}
                    >
                        {isCapturing ? (
                            <>
                                <Square size={14} /> Stop Capture
                            </>
                        ) : (
                            <>
                                <Play size={14} /> Start Capture
                            </>
                        )}
                    </button>
                    <button
                        className="primary-btn"
                        onClick={analyzeScreenNow}
                        title="Analyze Screen (Cmd+Shift+S)"
                    >
                        <Camera size={14} /> Snapshot
                    </button>
                </div>
            </div>
        </div>
    );
}

export default App;
