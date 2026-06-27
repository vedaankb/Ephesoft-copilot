/**
 * Ephesoft Copilot — floating panel
 *
 * Two connection indicators:
 *   ● panel  → Electron renderer ↔ FastAPI (/ws/panel)
 *   ● ext    → Browser extension ↔ FastAPI (/ws/extension)
 *
 * Settings modal lets the user enter / test the Gemini API key.
 * Fill / Next / "I edited" call into the FastAPI agent.
 */

const { useState, useEffect, useRef, useCallback } = React;

const STATE = {
    IDLE: 'IDLE',
    FILLING: 'FILLING',
    NEXT_LOADING: 'NEXT_LOADING',
    COMPLETE: 'COMPLETE',
    ERROR: 'ERROR',
};

const DOC_TYPE_COLORS = {
    invoice: '#3b82f6',
    pharmacy: '#10b981',
    estimate: '#f59e0b',
    medical_records: '#8b5cf6',
    claim_form: '#06b6d4',
    online_provider: '#ec4899',
    incomplete: '#ef4444',
};

const API_BASE = 'http://127.0.0.1:8000';

function App() {
    const [state, setState] = useState(STATE.IDLE);
    const [statusFeed, setStatusFeed] = useState([]);
    const [docType, setDocType] = useState(null);
    const [redFields, setRedFields] = useState([]);
    const [flags, setFlags] = useState([]);
    const [error, setError] = useState(null);
    const [batchInfo, setBatchInfo] = useState(null);

    const [panelConnected, setPanelConnected] = useState(false);
    const [extConnected, setExtConnected] = useState(false);

    const [showSettings, setShowSettings] = useState(false);
    const [hasApiKey, setHasApiKey] = useState(false);
    const [keyPreview, setKeyPreview] = useState(null);

    const wsRef = useRef(null);
    const reconnectRef = useRef(null);
    const mountedRef = useRef(true);

    const addStatusMessage = useCallback((message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setStatusFeed(prev => [...prev, { message, type, timestamp }]);
    }, []);

    const refreshSettings = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/settings`);
            const data = await res.json();
            setHasApiKey(!!data.has_api_key);
            setKeyPreview(data.key_preview || null);
        } catch (e) {
            // server not up yet — fine
        }
    }, []);

    // WebSocket lifecycle with auto-retry
    useEffect(() => {
        mountedRef.current = true;
        const wsUrl = window.api.getWebSocketUrl();
        let attempt = 0;

        const connect = () => {
            if (!mountedRef.current) return;
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                attempt = 0;
                setPanelConnected(true);
                setError(null);
                addStatusMessage('Panel connected to backend', 'success');
                refreshSettings();
            };

            ws.onmessage = (event) => {
                let message;
                try { message = JSON.parse(event.data); } catch { return; }
                handleServerMessage(message);
            };

            ws.onerror = () => setPanelConnected(false);

            ws.onclose = () => {
                setPanelConnected(false);
                setExtConnected(false);
                wsRef.current = null;
                if (!mountedRef.current) return;
                attempt += 1;
                const delay = Math.min(1000 * attempt, 5000);
                reconnectRef.current = setTimeout(connect, delay);
            };
        };

        connect();
        return () => {
            mountedRef.current = false;
            if (reconnectRef.current) clearTimeout(reconnectRef.current);
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) wsRef.current.close();
        };
    }, [addStatusMessage, refreshSettings]);

    const handleServerMessage = (message) => {
        switch (message.type) {
            case 'status':
                addStatusMessage(message.message);
                break;
            case 'action_complete':
                addStatusMessage(`✓ ${message.action}`, 'success');
                break;
            case 'action_error':
                addStatusMessage(`✗ ${message.action}: ${message.error}`, 'error');
                break;
            case 'complete':
                setState(STATE.COMPLETE);
                setDocType(message.doc_type);
                setRedFields(message.red_fields || []);
                setFlags(message.flags || []);
                addStatusMessage('Fill complete — review and Validate yourself', 'success');
                break;
            case 'incomplete':
                setState(STATE.COMPLETE);
                setDocType('incomplete');
                setFlags(message.flags || []);
                addStatusMessage(`Flagged: ${message.reason}`, 'warning');
                break;
            case 'batch_opened':
                setState(STATE.IDLE);
                setBatchInfo({ id: message.batch_id, created_at: message.created_at });
                addStatusMessage(`Opened batch: ${message.batch_id}`, 'success');
                break;
            case 'extension_status':
                setExtConnected(!!message.connected);
                addStatusMessage(
                    message.connected ? 'Browser extension connected' : 'Browser extension disconnected',
                    message.connected ? 'success' : 'warning'
                );
                break;
            case 'error':
                setState(STATE.ERROR);
                setError(message.message);
                addStatusMessage(`Error: ${message.message}`, 'error');
                break;
            case 'warning':
                addStatusMessage(message.message, 'warning');
                break;
            case 'pong':
                break;
            default:
                break;
        }
    };

    const send = (msg) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(msg));
        }
    };

    const handleFillClick = () => {
        if (!extConnected) {
            alert('Browser extension is not connected. Open Ephesoft (or the mock page) in Chrome with the extension loaded.');
            return;
        }
        if (!hasApiKey) {
            alert('Gemini API key not set. Open Settings (gear icon) and add your AIza... key.');
            setShowSettings(true);
            return;
        }
        setState(STATE.FILLING);
        setStatusFeed([]);
        setDocType(null);
        setRedFields([]);
        setFlags([]);
        setError(null);
        send({ type: 'fill' });
    };

    const handleNextClick = () => {
        if (!extConnected) {
            alert('Browser extension is not connected.');
            return;
        }
        if (!hasApiKey) {
            alert('Gemini API key not set.');
            setShowSettings(true);
            return;
        }
        setState(STATE.NEXT_LOADING);
        setStatusFeed([]);
        send({ type: 'next' });
    };

    const handleEditedClick = () => {
        send({ type: 'human_edit' });
    };

    const handleRetryClick = () => {
        setState(STATE.IDLE);
        setError(null);
        setStatusFeed([]);
    };

    return (
        <div className="app">
            <header className="header">
                <h1>Ephesoft Copilot</h1>
                <div className="header-right">
                    <Dot label="panel" connected={panelConnected} />
                    <Dot label="ext" connected={extConnected} />
                    <button className="icon-btn" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
                </div>
            </header>

            <main className="main">
                {!panelConnected && state !== STATE.ERROR && (
                    <p className="connecting-hint">Connecting to backend…</p>
                )}
                {panelConnected && !extConnected && state !== STATE.ERROR && (
                    <p className="connecting-hint">
                        Browser extension not connected. Open Ephesoft (or the mock page) in Chrome.
                    </p>
                )}
                {panelConnected && extConnected && !hasApiKey && state !== STATE.ERROR && (
                    <p className="connecting-hint warn">
                        No Gemini API key. <a onClick={() => setShowSettings(true)}>Add one →</a>
                    </p>
                )}

                {state === STATE.IDLE && (
                    <div className="button-group">
                        <button className="btn btn-primary" onClick={handleFillClick} disabled={!panelConnected}>Fill</button>
                        <button className="btn btn-secondary" onClick={handleNextClick} disabled={!panelConnected}>Next</button>
                    </div>
                )}

                {batchInfo && state === STATE.IDLE && (
                    <div className="batch-info">
                        <div className="batch-id">{batchInfo.id}</div>
                        <div className="batch-date">{batchInfo.created_at ? new Date(batchInfo.created_at).toLocaleString() : ''}</div>
                    </div>
                )}

                {(state === STATE.FILLING || state === STATE.NEXT_LOADING) && (
                    <div className="filling-state">
                        <div className="spinner"></div>
                        <div className="filling-label">{state === STATE.FILLING ? 'Filling...' : 'Loading next batch...'}</div>
                    </div>
                )}

                {state === STATE.COMPLETE && docType && (
                    <div className="complete-state">
                        <div className="doc-type-badge" style={{ backgroundColor: DOC_TYPE_COLORS[docType] || '#6b7280' }}>
                            {docType.replace('_', ' ')}
                        </div>
                        {redFields.length > 0 && (
                            <div className="red-fields">
                                <h3>Red Fields ({redFields.length})</h3>
                                <ul>{redFields.map((f, i) => <li key={i}>{f}</li>)}</ul>
                            </div>
                        )}
                        {flags.length > 0 && (
                            <div className="flags">
                                <h3>Flags</h3>
                                <ul>{flags.map((f, i) => <li key={i} className="flag-item">⚠ {f}</li>)}</ul>
                            </div>
                        )}
                        <button className="btn btn-secondary" onClick={handleEditedClick}>I edited</button>
                        <button className="btn btn-primary" onClick={handleRetryClick}>Done</button>
                    </div>
                )}

                {state === STATE.ERROR && (
                    <div className="error-state">
                        <div className="error-message">{error}</div>
                        <button className="btn btn-primary" onClick={handleRetryClick}>Retry</button>
                    </div>
                )}

                {statusFeed.length > 0 && (
                    <div className="status-feed">
                        <h3>Status</h3>
                        <div className="feed-list">
                            {statusFeed.slice(-50).map((item, idx) => (
                                <div key={idx} className={`feed-item feed-item-${item.type}`}>
                                    <span className="feed-time">{item.timestamp}</span>
                                    <span className="feed-message">{item.message}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </main>

            {showSettings && (
                <SettingsModal
                    onClose={() => { setShowSettings(false); refreshSettings(); }}
                    hasApiKey={hasApiKey}
                    keyPreview={keyPreview}
                />
            )}
        </div>
    );
}

function Dot({ label, connected }) {
    return (
        <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} title={`${label}: ${connected ? 'connected' : 'disconnected'}`}>
            <span className="dot-bullet">●</span>
            <span className="dot-label">{label}</span>
        </span>
    );
}

function SettingsModal({ onClose, hasApiKey, keyPreview }) {
    const [keyInput, setKeyInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);

    const save = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const res = await fetch(`${API_BASE}/api/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: keyInput.trim() }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                setMessage({ ok: false, text: data.detail || 'Save failed' });
            } else {
                setMessage({ ok: true, text: 'Saved' });
                setKeyInput('');
            }
        } catch (e) {
            setMessage({ ok: false, text: String(e) });
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        setBusy(true);
        setMessage(null);
        try {
            const res = await fetch(`${API_BASE}/api/test_key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: keyInput.trim() }),
            });
            const data = await res.json();
            setMessage({ ok: !!data.ok, text: data.message || (res.ok ? 'OK' : 'Failed') });
        } catch (e) {
            setMessage({ ok: false, text: String(e) });
        } finally {
            setBusy(false);
        }
    };

    const clear = async () => {
        if (!confirm('Remove the stored API key from your keychain?')) return;
        setBusy(true);
        await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: '' }),
        });
        setMessage({ ok: true, text: 'Cleared' });
        setBusy(false);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Settings</h2>
                    <button className="icon-btn" onClick={onClose}>✕</button>
                </div>
                <div className="modal-body">
                    <label>Gemini API key (Google AI Studio)</label>
                    <p className="hint">
                        Get one at <span className="mono">aistudio.google.com/apikey</span>. Starts with AIza.
                        Stored in your OS keychain.
                    </p>
                    <input
                        type="password"
                        placeholder={hasApiKey ? `Current: ${keyPreview || 'set'}` : 'AIzaSy…'}
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                    />
                    <div className="modal-actions">
                        <button className="btn btn-secondary" onClick={test} disabled={busy || !keyInput.trim()}>Test key</button>
                        <button className="btn btn-primary" onClick={save} disabled={busy || !keyInput.trim()}>Save</button>
                        {hasApiKey && (
                            <button className="btn btn-danger" onClick={clear} disabled={busy}>Clear</button>
                        )}
                    </div>
                    {message && (
                        <div className={`modal-message ${message.ok ? 'ok' : 'err'}`}>
                            {message.text}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
