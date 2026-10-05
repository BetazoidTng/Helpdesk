// Agent-side WebRTC logic. Mirrors public/remote-assist.html's staff-side
// logic closely (same signaling protocol, same relay), with one
// deliberate asymmetry: this side always initiates the actual WebRTC
// offer (and only after the person sitting at this computer clicks
// "Allow" -- see showConsent() below), since it's the one with a screen
// to share. The staff side just waits for an offer and answers it.
let ws = null;
let pc = null;
let dataChannel = null;
let screenInfo = null;
let ended = false;
let pendingIce = [];

const connectPanel = document.getElementById('connect-panel');
const consentPanel = document.getElementById('consent-panel');
const sessionPanel = document.getElementById('session-panel');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const sessionStatusEl = document.getElementById('session-status');
const sessionBanner = document.getElementById('session-banner');

function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}

function clearError() {
    errorEl.style.display = 'none';
}

function wsUrl(serverUrl, code) {
    const base = serverUrl.trim().replace(/\/+$/, '');
    const wsBase = base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
    return `${wsBase}/remote-assist/signal?code=${encodeURIComponent(code)}&role=agent`;
}

function sendToRelay(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

document.getElementById('connect-btn').addEventListener('click', () => {
    clearError();
    const serverUrl = document.getElementById('serverUrl').value.trim();
    const code = document.getElementById('code').value.trim().toUpperCase();
    if (!serverUrl || !code) {
        showError('Enter both the server address and the code support gave you.');
        return;
    }

    try {
        ws = new WebSocket(wsUrl(serverUrl, code));
    } catch (err) {
        showError('That server address looks invalid.');
        return;
    }

    document.getElementById('connect-btn').disabled = true;
    statusEl.textContent = 'Connecting...';

    ws.addEventListener('open', () => {
        statusEl.textContent = 'Connected. Waiting for your support agent...';
    });
    ws.addEventListener('close', (e) => {
        document.getElementById('connect-btn').disabled = false;
        if (!ended) {
            statusEl.textContent = '';
            showError(`Disconnected (code ${e.code}). The code may be wrong, expired, or already used.`);
        }
    });
    ws.addEventListener('error', () => {
        showError('Could not reach that server. Check the address and try again.');
    });
    ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        handleSignalMessage(msg);
    });
});

function handleSignalMessage(msg) {
    if ((msg.type === 'peer-joined' || msg.type === 'peer-present') && msg.role === 'staff') {
        showConsent();
    } else if (msg.type === 'peer-left' && msg.role === 'staff') {
        sessionStatusEl.textContent = 'The support agent disconnected.';
        teardownPeerConnection();
    } else if (msg.type === 'session-ended') {
        ended = true;
        teardownPeerConnection();
        if (ws) ws.close();
        showEndedState('This session was ended.');
    } else if (msg.type === 'signal' && msg.from === 'staff') {
        let inner;
        try { inner = JSON.parse(msg.data); } catch (err) { return; }
        handleStaffSignal(inner);
    }
}

function showConsent() {
    if (consentPanel.style.display === 'block' || sessionPanel.style.display === 'block') return; // already past this step
    connectPanel.style.display = 'none';
    consentPanel.style.display = 'block';
}

document.getElementById('allow-btn').addEventListener('click', async () => {
    consentPanel.style.display = 'none';
    sessionPanel.style.display = 'block';
    sessionStatusEl.textContent = 'Starting screen share...';
    try {
        await startSharing();
    } catch (err) {
        sessionStatusEl.textContent = `Could not start screen sharing: ${err.message}`;
    }
});

document.getElementById('deny-btn').addEventListener('click', () => {
    sendToRelay({ type: 'denied' });
    consentPanel.style.display = 'none';
    connectPanel.style.display = 'block';
    statusEl.textContent = '';
    showError('You declined the session. Nothing was shared.');
    if (ws) { ended = true; ws.close(); ended = false; }
});

async function startSharing() {
    const source = await window.remoteAgent.getScreenSource();
    if (!source.sourceId) throw new Error('No screen source available.');
    screenInfo = { width: source.width, height: source.height };

    // Electron-specific getUserMedia constraint shape (not the standard
    // getDisplayMedia()) -- this is what lets desktopCapturer's source id
    // actually be captured, and deliberately skips Electron's normal
    // screen-picker dialog since the consent step above already covers
    // that, and we always want the whole primary screen, not a choice of
    // windows.
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
            mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: source.sourceId,
                maxWidth: source.width,
                maxHeight: source.height,
            },
        },
    });

    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    stream.getVideoTracks().forEach((track) => pc.addTrack(track, stream));
    dataChannel = pc.createDataChannel('control');
    wireDataChannel();

    pc.onicecandidate = (e) => {
        if (e.candidate) sendToRelay({ type: 'ice', candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            sessionStatusEl.textContent = 'Connected. The agent can see your screen, and can control it once you see them doing it.';
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            sessionStatusEl.textContent = `Connection ${pc.connectionState}.`;
        }
    };

    sendToRelay({ type: 'hello', width: source.width, height: source.height });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendToRelay({ type: 'offer', sdp: pc.localDescription });
}

async function handleStaffSignal(inner) {
    if (inner.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(inner.sdp));
        for (const candidate of pendingIce) {
            await pc.addIceCandidate(candidate).catch(() => {});
        }
        pendingIce = [];
    } else if (inner.type === 'ice') {
        if (pc && pc.remoteDescription) {
            await pc.addIceCandidate(inner.candidate).catch(() => {});
        } else {
            pendingIce.push(inner.candidate);
        }
    }
}

function wireDataChannel() {
    dataChannel.addEventListener('open', () => {
        sessionBanner.classList.add('controlling');
    });
    dataChannel.addEventListener('message', (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.type === 'chat') {
            appendChat('Support agent', msg.text);
            return;
        }
        // Everything else is a mouse/keyboard event -- hand it straight
        // to the main process for actual input injection (see
        // preload.js / main.js / inputInjector.js). This renderer never
        // touches nut.js directly.
        window.remoteAgent.sendControl(msg);
    });
}

function appendChat(author, text) {
    const log = document.getElementById('chat-log');
    const row = document.createElement('div');
    row.className = 'msg';
    const strong = document.createElement('strong');
    strong.textContent = author + ': ';
    row.appendChild(strong);
    row.appendChild(document.createTextNode(text));
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
}

document.getElementById('chat-send-btn').addEventListener('click', sendChat);
document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
});

function sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'chat', text }));
        appendChat('You', text);
        input.value = '';
    }
}

document.getElementById('end-btn').addEventListener('click', () => {
    ended = true;
    teardownPeerConnection();
    if (ws) ws.close();
    showEndedState('You ended the session.');
});

function teardownPeerConnection() {
    if (pc) {
        try { pc.close(); } catch (err) { /* already closed */ }
        pc = null;
    }
    dataChannel = null;
    sessionBanner.classList.remove('controlling');
}

function showEndedState(message) {
    sessionPanel.style.display = 'none';
    connectPanel.style.display = 'block';
    document.getElementById('connect-btn').disabled = false;
    statusEl.textContent = '';
    showError(message);
}
