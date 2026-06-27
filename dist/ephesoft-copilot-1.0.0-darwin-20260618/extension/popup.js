const dotEl = document.getElementById('dot');
const statusEl = document.getElementById('status');
const reconnectBtn = document.getElementById('reconnect');

function render(connected) {
    dotEl.className = 'dot ' + (connected ? 'on' : 'off');
    statusEl.textContent = connected ? 'Connected to backend' : 'Disconnected';
}

chrome.runtime.sendMessage({ type: 'get_status' }, (res) => {
    if (res) render(!!res.connected);
});

chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'status') render(!!msg.connected);
});

reconnectBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'reconnect' });
});
