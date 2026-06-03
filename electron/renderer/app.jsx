/**
 * Ephesoft Copilot React UI
 * 
 * States: IDLE → FILLING → COMPLETE → ERROR
 * 
 * Features:
 * - Fill button (triggers fill loop)
 * - Next button (opens oldest batch)
 * - Status feed (live agent updates)
 * - Doc type badge with color coding
 * - Red fields list
 * - Flags display
 * - "I edited" button for quality tracking
 */

const { useState, useEffect, useRef } = React;

const STATE = {
    IDLE: 'IDLE',
    FILLING: 'FILLING',
    NEXT_LOADING: 'NEXT_LOADING',
    COMPLETE: 'COMPLETE',
    ERROR: 'ERROR'
};

const DOC_TYPE_COLORS = {
    invoice: '#3b82f6',      // blue
    pharmacy: '#10b981',     // green
    estimate: '#f59e0b',     // amber
    medical_records: '#8b5cf6', // purple
    claim_form: '#06b6d4',   // cyan
    online_provider: '#ec4899', // pink
    incomplete: '#ef4444'    // red
};

function App() {
    const [state, setState] = useState(STATE.IDLE);
    const [statusFeed, setStatusFeed] = useState([]);
    const [docType, setDocType] = useState(null);
    const [redFields, setRedFields] = useState([]);
    const [flags, setFlags] = useState([]);
    const [error, setError] = useState(null);
    const [batchInfo, setBatchInfo] = useState(null);
    const [isConnected, setIsConnected] = useState(false);
    
    const wsRef = useRef(null);
    const reconnectTimerRef = useRef(null);
    const mountedRef = useRef(true);
    
    const addStatusMessage = (message, type = 'info') => {
        const timestamp = new Date().toLocaleTimeString();
        setStatusFeed(prev => [...prev, { message, type, timestamp }]);
    };
    
    // WebSocket connection with retry (server may still be starting Playwright)
    useEffect(() => {
        mountedRef.current = true;
        const wsUrl = window.api.getWebSocketUrl();
        let attempt = 0;
        const maxAttempts = 60;
        
        const connect = () => {
            if (!mountedRef.current) return;
            
            console.log('Connecting to:', wsUrl, `(attempt ${attempt + 1})`);
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;
            
            ws.onopen = () => {
                attempt = 0;
                console.log('WebSocket connected');
                setIsConnected(true);
                setError(null);
                if (state === STATE.ERROR) {
                    setState(STATE.IDLE);
                }
                setStatusFeed(prev => {
                    const hasConnected = prev.some(item => item.message === 'Connected to server');
                    if (hasConnected) return prev;
                    return [...prev, {
                        message: 'Connected to server',
                        type: 'success',
                        timestamp: new Date().toLocaleTimeString()
                    }];
                });
            };
            
            ws.onmessage = (event) => {
                const message = JSON.parse(event.data);
                handleServerMessage(message);
            };
            
            ws.onerror = () => {
                console.error('WebSocket error');
                setIsConnected(false);
            };
            
            ws.onclose = () => {
                console.log('WebSocket closed');
                setIsConnected(false);
                wsRef.current = null;
                
                if (!mountedRef.current) return;
                
                if (attempt < maxAttempts) {
                    attempt += 1;
                    const delay = Math.min(1000 * attempt, 5000);
                    reconnectTimerRef.current = setTimeout(connect, delay);
                } else {
                    setState(STATE.ERROR);
                    setError('Cannot reach server at ws://127.0.0.1:8000. Is the backend running?');
                }
            };
        };
        
        connect();
        
        return () => {
            mountedRef.current = false;
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
            }
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
                wsRef.current.close();
            }
        };
    }, []);
    
    // Handle messages from server
    const handleServerMessage = (message) => {
        console.log('Server message:', message);
        
        switch (message.type) {
            case 'status':
                addStatusMessage(message.message);
                break;
            
            case 'action_complete':
                addStatusMessage(`✓ ${message.action}`);
                break;
            
            case 'action_error':
                addStatusMessage(`✗ ${message.action}: ${message.error}`, 'error');
                break;
            
            case 'complete':
                setState(STATE.COMPLETE);
                setDocType(message.doc_type);
                setRedFields(message.red_fields || []);
                setFlags(message.flags || []);
                addStatusMessage('Fill complete!', 'success');
                break;
            
            case 'incomplete':
                setState(STATE.COMPLETE);
                setDocType('incomplete');
                setFlags(message.flags || []);
                addStatusMessage(`Flagged: ${message.reason}`, 'warning');
                break;
            
            case 'batch_opened':
                setState(STATE.IDLE);
                setBatchInfo({
                    id: message.batch_id,
                    created_at: message.created_at
                });
                addStatusMessage(`Opened: ${message.batch_id}`, 'success');
                break;
            
            case 'error':
                setState(STATE.ERROR);
                setError(message.message);
                addStatusMessage(`Error: ${message.message}`, 'error');
                break;
            
            case 'warning':
                addStatusMessage(message.message, 'warning');
                break;
        }
    };
    
    const handleFillClick = () => {
        if (!isConnected) {
            alert('Not connected to server');
            return;
        }
        
        setState(STATE.FILLING);
        setStatusFeed([]);
        setDocType(null);
        setRedFields([]);
        setFlags([]);
        setError(null);
        
        wsRef.current.send(JSON.stringify({ type: 'fill', payload: {} }));
    };
    
    const handleNextClick = () => {
        if (!isConnected) {
            alert('Not connected to server');
            return;
        }
        
        setState(STATE.NEXT_LOADING);
        setStatusFeed([]);
        
        wsRef.current.send(JSON.stringify({ type: 'next', payload: {} }));
    };
    
    const handleEditedClick = () => {
        if (!isConnected) return;
        wsRef.current.send(JSON.stringify({ type: 'human_edit', payload: {} }));
        alert('Marked as edited - logged for quality tracking');
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
                <div
                    className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}
                    title={isConnected ? 'Connected to server' : 'Waiting for server — retrying…'}
                >
                    {isConnected ? '●' : '○'}
                </div>
            </header>
            
            <main className="main">
                {/* Action buttons */}
                {!isConnected && state !== STATE.ERROR && (
                    <p className="connecting-hint">Connecting to server…</p>
                )}
                
                {state === STATE.IDLE && (
                    <div className="button-group">
                        <button 
                            className="btn btn-primary btn-fill"
                            onClick={handleFillClick}
                            disabled={!isConnected}
                        >
                            Fill
                        </button>
                        <button 
                            className="btn btn-secondary btn-next"
                            onClick={handleNextClick}
                            disabled={!isConnected}
                        >
                            Next
                        </button>
                    </div>
                )}
                
                {/* Batch info */}
                {batchInfo && state === STATE.IDLE && (
                    <div className="batch-info">
                        <div className="batch-id">{batchInfo.id}</div>
                        <div className="batch-date">
                            {new Date(batchInfo.created_at).toLocaleString()}
                        </div>
                    </div>
                )}
                
                {/* Filling state */}
                {(state === STATE.FILLING || state === STATE.NEXT_LOADING) && (
                    <div className="filling-state">
                        <div className="spinner"></div>
                        <div className="filling-label">
                            {state === STATE.FILLING ? 'Filling...' : 'Loading next batch...'}
                        </div>
                    </div>
                )}
                
                {/* Complete state */}
                {state === STATE.COMPLETE && docType && (
                    <div className="complete-state">
                        <div 
                            className="doc-type-badge"
                            style={{ backgroundColor: DOC_TYPE_COLORS[docType] || '#6b7280' }}
                        >
                            {docType.replace('_', ' ')}
                        </div>
                        
                        {redFields.length > 0 && (
                            <div className="red-fields">
                                <h3>Red Fields ({redFields.length})</h3>
                                <ul>
                                    {redFields.map((field, idx) => (
                                        <li key={idx}>{field}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        
                        {flags.length > 0 && (
                            <div className="flags">
                                <h3>Flags</h3>
                                <ul>
                                    {flags.map((flag, idx) => (
                                        <li key={idx} className="flag-item">⚠ {flag}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        
                        <button 
                            className="btn btn-secondary btn-edited"
                            onClick={handleEditedClick}
                        >
                            I edited
                        </button>
                        
                        <button 
                            className="btn btn-primary"
                            onClick={handleRetryClick}
                        >
                            Done
                        </button>
                    </div>
                )}
                
                {/* Error state */}
                {state === STATE.ERROR && (
                    <div className="error-state">
                        <div className="error-message">{error}</div>
                        <button 
                            className="btn btn-primary"
                            onClick={handleRetryClick}
                        >
                            Retry
                        </button>
                    </div>
                )}
                
                {/* Status feed */}
                {statusFeed.length > 0 && (
                    <div className="status-feed">
                        <h3>Status</h3>
                        <div className="feed-list">
                            {statusFeed.map((item, idx) => (
                                <div 
                                    key={idx} 
                                    className={`feed-item feed-item-${item.type}`}
                                >
                                    <span className="feed-time">{item.timestamp}</span>
                                    <span className="feed-message">{item.message}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
}

// Render
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
