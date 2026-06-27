import { jsxDEV as _jsxDEV } from "react/jsx-dev-runtime";
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
  return /*#__PURE__*/_jsxDEV("div", {
    className: "app",
    children: [/*#__PURE__*/_jsxDEV("header", {
      className: "header",
      children: [/*#__PURE__*/_jsxDEV("h1", {
        children: "Ephesoft Copilot"
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "header-right",
        children: [/*#__PURE__*/_jsxDEV(Dot, {
          label: "panel",
          connected: panelConnected
        }, void 0, false), /*#__PURE__*/_jsxDEV(Dot, {
          label: "ext",
          connected: extConnected
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: "icon-btn",
          onClick: () => setShowSettings(true),
          title: "Settings",
          children: "⚙"
        }, void 0, false)]
      }, void 0, true)]
    }, void 0, true), /*#__PURE__*/_jsxDEV("main", {
      className: "main",
      children: [!panelConnected && state !== STATE.ERROR && /*#__PURE__*/_jsxDEV("p", {
        className: "connecting-hint",
        children: "Connecting to backend…"
      }, void 0, false), panelConnected && !extConnected && state !== STATE.ERROR && /*#__PURE__*/_jsxDEV("p", {
        className: "connecting-hint",
        children: "Browser extension not connected. Open Ephesoft (or the mock page) in Chrome."
      }, void 0, false), panelConnected && extConnected && !hasApiKey && state !== STATE.ERROR && /*#__PURE__*/_jsxDEV("p", {
        className: "connecting-hint warn",
        children: ["No Gemini API key. ", /*#__PURE__*/_jsxDEV("a", {
          onClick: () => setShowSettings(true),
          children: "Add one →"
        }, void 0, false)]
      }, void 0, true), state === STATE.IDLE && /*#__PURE__*/_jsxDEV("div", {
        className: "button-group",
        children: [/*#__PURE__*/_jsxDEV("button", {
          className: "btn btn-primary",
          onClick: handleFillClick,
          disabled: !panelConnected,
          children: "Fill"
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: "btn btn-secondary",
          onClick: handleNextClick,
          disabled: !panelConnected,
          children: "Next"
        }, void 0, false)]
      }, void 0, true), batchInfo && state === STATE.IDLE && /*#__PURE__*/_jsxDEV("div", {
        className: "batch-info",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "batch-id",
          children: batchInfo.id
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "batch-date",
          children: batchInfo.created_at ? new Date(batchInfo.created_at).toLocaleString() : ''
        }, void 0, false)]
      }, void 0, true), (state === STATE.FILLING || state === STATE.NEXT_LOADING) && /*#__PURE__*/_jsxDEV("div", {
        className: "filling-state",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "spinner"
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "filling-label",
          children: state === STATE.FILLING ? 'Filling...' : 'Loading next batch...'
        }, void 0, false)]
      }, void 0, true), state === STATE.COMPLETE && docType && /*#__PURE__*/_jsxDEV("div", {
        className: "complete-state",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "doc-type-badge",
          style: {
            backgroundColor: DOC_TYPE_COLORS[docType] || '#6b7280'
          },
          children: docType.replace('_', ' ')
        }, void 0, false), redFields.length > 0 && /*#__PURE__*/_jsxDEV("div", {
          className: "red-fields",
          children: [/*#__PURE__*/_jsxDEV("h3", {
            children: ["Red Fields (", redFields.length, ")"]
          }, void 0, true), /*#__PURE__*/_jsxDEV("ul", {
            children: redFields.map((f, i) => /*#__PURE__*/_jsxDEV("li", {
              children: f
            }, i, false))
          }, void 0, false)]
        }, void 0, true), flags.length > 0 && /*#__PURE__*/_jsxDEV("div", {
          className: "flags",
          children: [/*#__PURE__*/_jsxDEV("h3", {
            children: "Flags"
          }, void 0, false), /*#__PURE__*/_jsxDEV("ul", {
            children: flags.map((f, i) => /*#__PURE__*/_jsxDEV("li", {
              className: "flag-item",
              children: ["⚠ ", f]
            }, i, true))
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
          className: "btn btn-secondary",
          onClick: handleEditedClick,
          children: "I edited"
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: "btn btn-primary",
          onClick: handleRetryClick,
          children: "Done"
        }, void 0, false)]
      }, void 0, true), state === STATE.ERROR && /*#__PURE__*/_jsxDEV("div", {
        className: "error-state",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "error-message",
          children: error
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: "btn btn-primary",
          onClick: handleRetryClick,
          children: "Retry"
        }, void 0, false)]
      }, void 0, true), statusFeed.length > 0 && /*#__PURE__*/_jsxDEV("div", {
        className: "status-feed",
        children: [/*#__PURE__*/_jsxDEV("h3", {
          children: "Status"
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "feed-list",
          children: statusFeed.slice(-50).map((item, idx) => /*#__PURE__*/_jsxDEV("div", {
            className: `feed-item feed-item-${item.type}`,
            children: [/*#__PURE__*/_jsxDEV("span", {
              className: "feed-time",
              children: item.timestamp
            }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
              className: "feed-message",
              children: item.message
            }, void 0, false)]
          }, idx, true))
        }, void 0, false)]
      }, void 0, true)]
    }, void 0, true), showSettings && /*#__PURE__*/_jsxDEV(SettingsModal, {
      onClose: () => {
        setShowSettings(false);
        refreshSettings();
      },
      hasApiKey: hasApiKey,
      keyPreview: keyPreview
    }, void 0, false)]
  }, void 0, true);
}
function Dot({
  label,
  connected
}) {
  return /*#__PURE__*/_jsxDEV("span", {
    className: `dot ${connected ? 'dot-on' : 'dot-off'}`,
    title: `${label}: ${connected ? 'connected' : 'disconnected'}`,
    children: [/*#__PURE__*/_jsxDEV("span", {
      className: "dot-bullet",
      children: "●"
    }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
      className: "dot-label",
      children: label
    }, void 0, false)]
  }, void 0, true);
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
  return /*#__PURE__*/_jsxDEV("div", {
    className: "modal-overlay",
    onClick: onClose,
    children: /*#__PURE__*/_jsxDEV("div", {
      className: "modal",
      onClick: e => e.stopPropagation(),
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "modal-header",
        children: [/*#__PURE__*/_jsxDEV("h2", {
          children: "Settings"
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: "icon-btn",
          onClick: onClose,
          children: "✕"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "modal-body",
        children: [/*#__PURE__*/_jsxDEV("label", {
          children: "Gemini API key (Google AI Studio)"
        }, void 0, false), /*#__PURE__*/_jsxDEV("p", {
          className: "hint",
          children: ["Get one at ", /*#__PURE__*/_jsxDEV("span", {
            className: "mono",
            children: "aistudio.google.com/apikey"
          }, void 0, false), ". Starts with AIza. Stored in your OS keychain."]
        }, void 0, true), /*#__PURE__*/_jsxDEV("input", {
          type: "password",
          placeholder: hasApiKey ? `Current: ${keyPreview || 'set'}` : 'AIzaSy…',
          value: keyInput,
          onChange: e => setKeyInput(e.target.value)
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "modal-actions",
          children: [/*#__PURE__*/_jsxDEV("button", {
            className: "btn btn-secondary",
            onClick: test,
            disabled: busy || !keyInput.trim(),
            children: "Test key"
          }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
            className: "btn btn-primary",
            onClick: save,
            disabled: busy || !keyInput.trim(),
            children: "Save"
          }, void 0, false), hasApiKey && /*#__PURE__*/_jsxDEV("button", {
            className: "btn btn-danger",
            onClick: clear,
            disabled: busy,
            children: "Clear"
          }, void 0, false)]
        }, void 0, true), message && /*#__PURE__*/_jsxDEV("div", {
          className: `modal-message ${message.ok ? 'ok' : 'err'}`,
          children: message.text
        }, void 0, false)]
      }, void 0, true)]
    }, void 0, true)
  }, void 0, false);
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(/*#__PURE__*/_jsxDEV(App, {}, void 0, false));