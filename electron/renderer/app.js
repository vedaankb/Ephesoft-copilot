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

const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;
const STATE = {
  IDLE: 'IDLE',
  FILLING: 'FILLING',
  NEXT_LOADING: 'NEXT_LOADING',
  COMPLETE: 'COMPLETE',
  ERROR: 'ERROR'
};
const DOC_TYPE_COLORS = {
  invoice: '#3b82f6',
  pharmacy: '#10b981',
  estimate: '#f59e0b',
  medical_records: '#8b5cf6',
  claim_form: '#06b6d4',
  online_provider: '#ec4899',
  incomplete: '#ef4444'
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
    setStatusFeed(prev => [...prev, {
      message,
      type,
      timestamp
    }]);
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
      ws.onmessage = event => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
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
  const handleServerMessage = message => {
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
        setBatchInfo({
          id: message.batch_id,
          created_at: message.created_at
        });
        addStatusMessage(`Opened batch: ${message.batch_id}`, 'success');
        break;
      case 'extension_status':
        setExtConnected(!!message.connected);
        addStatusMessage(message.connected ? 'Browser extension connected' : 'Browser extension disconnected', message.connected ? 'success' : 'warning');
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
  const send = msg => {
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
    send({
      type: 'fill'
    });
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
    send({
      type: 'next'
    });
  };
  const handleEditedClick = () => {
    send({
      type: 'human_edit'
    });
  };
  const handleRetryClick = () => {
    setState(STATE.IDLE);
    setError(null);
    setStatusFeed([]);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "app"
  }, /*#__PURE__*/React.createElement("header", {
    className: "header"
  }, /*#__PURE__*/React.createElement("h1", null, "Ephesoft Copilot"), /*#__PURE__*/React.createElement("div", {
    className: "header-right"
  }, /*#__PURE__*/React.createElement(Dot, {
    label: "panel",
    connected: panelConnected
  }), /*#__PURE__*/React.createElement(Dot, {
    label: "ext",
    connected: extConnected
  }), /*#__PURE__*/React.createElement("button", {
    className: "icon-btn",
    onClick: () => setShowSettings(true),
    title: "Settings"
  }, "⚙"))), /*#__PURE__*/React.createElement("main", {
    className: "main"
  }, !panelConnected && state !== STATE.ERROR && /*#__PURE__*/React.createElement("p", {
    className: "connecting-hint"
  }, "Connecting to backend…"), panelConnected && !extConnected && state !== STATE.ERROR && /*#__PURE__*/React.createElement("p", {
    className: "connecting-hint"
  }, "Browser extension not connected. Open Ephesoft (or the mock page) in Chrome."), panelConnected && extConnected && !hasApiKey && state !== STATE.ERROR && /*#__PURE__*/React.createElement("p", {
    className: "connecting-hint warn"
  }, "No Gemini API key. ", /*#__PURE__*/React.createElement("a", {
    onClick: () => setShowSettings(true)
  }, "Add one →")), state === STATE.IDLE && /*#__PURE__*/React.createElement("div", {
    className: "button-group"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: handleFillClick,
    disabled: !panelConnected
  }, "Fill"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-secondary",
    onClick: handleNextClick,
    disabled: !panelConnected
  }, "Next")), batchInfo && state === STATE.IDLE && /*#__PURE__*/React.createElement("div", {
    className: "batch-info"
  }, /*#__PURE__*/React.createElement("div", {
    className: "batch-id"
  }, batchInfo.id), /*#__PURE__*/React.createElement("div", {
    className: "batch-date"
  }, batchInfo.created_at ? new Date(batchInfo.created_at).toLocaleString() : '')), (state === STATE.FILLING || state === STATE.NEXT_LOADING) && /*#__PURE__*/React.createElement("div", {
    className: "filling-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "spinner"
  }), /*#__PURE__*/React.createElement("div", {
    className: "filling-label"
  }, state === STATE.FILLING ? 'Filling...' : 'Loading next batch...')), state === STATE.COMPLETE && docType && /*#__PURE__*/React.createElement("div", {
    className: "complete-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "doc-type-badge",
    style: {
      backgroundColor: DOC_TYPE_COLORS[docType] || '#6b7280'
    }
  }, docType.replace('_', ' ')), redFields.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "red-fields"
  }, /*#__PURE__*/React.createElement("h3", null, "Red Fields (", redFields.length, ")"), /*#__PURE__*/React.createElement("ul", null, redFields.map((f, i) => /*#__PURE__*/React.createElement("li", {
    key: i
  }, f)))), flags.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "flags"
  }, /*#__PURE__*/React.createElement("h3", null, "Flags"), /*#__PURE__*/React.createElement("ul", null, flags.map((f, i) => /*#__PURE__*/React.createElement("li", {
    key: i,
    className: "flag-item"
  }, "⚠ ", f)))), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-secondary",
    onClick: handleEditedClick
  }, "I edited"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: handleRetryClick
  }, "Done")), state === STATE.ERROR && /*#__PURE__*/React.createElement("div", {
    className: "error-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "error-message"
  }, error), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: handleRetryClick
  }, "Retry")), statusFeed.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "status-feed"
  }, /*#__PURE__*/React.createElement("h3", null, "Status"), /*#__PURE__*/React.createElement("div", {
    className: "feed-list"
  }, statusFeed.slice(-50).map((item, idx) => /*#__PURE__*/React.createElement("div", {
    key: idx,
    className: `feed-item feed-item-${item.type}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "feed-time"
  }, item.timestamp), /*#__PURE__*/React.createElement("span", {
    className: "feed-message"
  }, item.message)))))), showSettings && /*#__PURE__*/React.createElement(SettingsModal, {
    onClose: () => {
      setShowSettings(false);
      refreshSettings();
    },
    hasApiKey: hasApiKey,
    keyPreview: keyPreview
  }));
}
function Dot({
  label,
  connected
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `dot ${connected ? 'dot-on' : 'dot-off'}`,
    title: `${label}: ${connected ? 'connected' : 'disconnected'}`
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot-bullet"
  }, "●"), /*#__PURE__*/React.createElement("span", {
    className: "dot-label"
  }, label));
}
function SettingsModal({
  onClose,
  hasApiKey,
  keyPreview
}) {
  const [keyInput, setKeyInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/settings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          api_key: keyInput.trim()
        })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({
          ok: false,
          text: data.detail || 'Save failed'
        });
      } else {
        setMessage({
          ok: true,
          text: 'Saved'
        });
        setKeyInput('');
      }
    } catch (e) {
      setMessage({
        ok: false,
        text: String(e)
      });
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
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          api_key: keyInput.trim()
        })
      });
      const data = await res.json();
      setMessage({
        ok: !!data.ok,
        text: data.message || (res.ok ? 'OK' : 'Failed')
      });
    } catch (e) {
      setMessage({
        ok: false,
        text: String(e)
      });
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!confirm('Remove the stored API key from your keychain?')) return;
    setBusy(true);
    await fetch(`${API_BASE}/api/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        api_key: ''
      })
    });
    setMessage({
      ok: true,
      text: 'Cleared'
    });
    setBusy(false);
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-overlay",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("h2", null, "Settings"), /*#__PURE__*/React.createElement("button", {
    className: "icon-btn",
    onClick: onClose
  }, "✕")), /*#__PURE__*/React.createElement("div", {
    className: "modal-body"
  }, /*#__PURE__*/React.createElement("label", null, "Gemini API key (Google AI Studio)"), /*#__PURE__*/React.createElement("p", {
    className: "hint"
  }, "Get one at ", /*#__PURE__*/React.createElement("span", {
    className: "mono"
  }, "aistudio.google.com/apikey"), ". Starts with AIza. Stored in your OS keychain."), /*#__PURE__*/React.createElement("input", {
    type: "password",
    placeholder: hasApiKey ? `Current: ${keyPreview || 'set'}` : 'AIzaSy…',
    value: keyInput,
    onChange: e => setKeyInput(e.target.value)
  }), /*#__PURE__*/React.createElement("div", {
    className: "modal-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-secondary",
    onClick: test,
    disabled: busy || !keyInput.trim()
  }, "Test key"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: save,
    disabled: busy || !keyInput.trim()
  }, "Save"), hasApiKey && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-danger",
    onClick: clear,
    disabled: busy
  }, "Clear")), message && /*#__PURE__*/React.createElement("div", {
    className: `modal-message ${message.ok ? 'ok' : 'err'}`
  }, message.text))));
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(/*#__PURE__*/React.createElement(App, null));