// WebSocket signaling relay for Remote Assist (see server/routes/remoteAssist.js
// for the REST side, and public/remote-assist.html / remote-agent/ for the
// two WebRTC peers this introduces to each other).
//
// This module never sees the screen video or the mouse/keyboard control
// events themselves -- those travel directly between the staff member's
// browser and the customer's agent app over a peer-to-peer WebRTC
// connection, once it's established. All this relay does is pass along
// the handful of small signaling messages (SDP offer/answer, ICE
// candidates) each side needs to find and connect to the other, matched
// up by the short join Code shown on the ticket.
const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { sql, getPool } = require('../db/pool');

// code -> { staff: ws|null, agent: ws|null }
const rooms = new Map();

function roomFor(code) {
    let room = rooms.get(code);
    if (!room) {
        room = { staff: null, agent: null };
        rooms.set(code, room);
    }
    return room;
}

function cleanupRoom(code) {
    const room = rooms.get(code);
    if (room && !room.staff && !room.agent) rooms.delete(code);
}

function send(ws, message) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

async function loadSession(code) {
    const pool = await getPool();
    const result = await pool.request().input('code', sql.NVarChar, code)
        .query("SELECT Id, Status, TicketId, CreatedAt FROM dbo.RemoteSessions WHERE Code = @code");
    return result.recordset[0] || null;
}

async function markConnected(sessionId) {
    const pool = await getPool();
    await pool.request().input('id', sql.Int, sessionId).query(`
        UPDATE dbo.RemoteSessions SET Status = 'Connected', ConnectedAt = COALESCE(ConnectedAt, SYSUTCDATETIME())
        WHERE Id = @id
    `);
}

// A Pending session (no one has joined on the agent side yet) that's more
// than 30 minutes old is treated as expired -- the code was shown once on
// a ticket and never used, so there's no reason to leave it valid
// indefinitely. A session that's already Connected has no such cutoff:
// it runs until a human ends it (see routes/remoteAssist.js's /end route).
function isExpired(sessionRow) {
    if (sessionRow.Status !== 'Pending') return false;
    const ageMs = Date.now() - new Date(sessionRow.CreatedAt).getTime();
    return ageMs > 30 * 60 * 1000;
}

// Attaches this relay to an http.Server or https.Server's "upgrade" event.
// Safe to call once per server instance (e.g. once for HTTP, once for
// HTTPS, if both are running) -- they share the same in-memory rooms map,
// since a code is global to this process regardless of which port it
// came in on.
function attachSignaling(httpServer) {
    if (!httpServer) return;
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
        let url;
        try {
            url = new URL(req.url, 'http://localhost');
        } catch (err) {
            socket.destroy();
            return;
        }
        if (url.pathname !== '/remote-assist/signal') return; // not ours -- leave it alone

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req, url);
        });
    });

    wss.on('connection', async (ws, req, url) => {
        const code = (url.searchParams.get('code') || '').trim().toUpperCase();
        const role = url.searchParams.get('role'); // 'staff' or 'agent'

        if (!code || (role !== 'staff' && role !== 'agent')) {
            ws.close(4400, 'Missing or invalid code/role.');
            return;
        }

        let sessionRow;
        try {
            sessionRow = await loadSession(code);
        } catch (err) {
            ws.close(1011, 'Lookup failed.');
            return;
        }
        if (!sessionRow || sessionRow.Status === 'Ended' || isExpired(sessionRow)) {
            ws.close(4404, 'This session code is invalid, expired, or has ended.');
            return;
        }

        const room = roomFor(code);
        const otherRole = role === 'staff' ? 'agent' : 'staff';

        // Only one of each role at a time -- a second staff/agent trying
        // the same code bumps the previous connection for that role
        // rather than silently failing (e.g. the agent's screen capture
        // app crashed and reconnected).
        if (room[role]) {
            try { room[role].close(4409, 'Replaced by a new connection.'); } catch (err) { /* already gone */ }
        }
        room[role] = ws;

        if (role === 'agent') {
            markConnected(sessionRow.Id).catch((err) => console.error('Failed to mark remote session connected:', err.message));
        }

        // Tell the other side (if it's already here) that this one just
        // joined, AND tell this one, right now, whether the other side
        // was already here -- whichever order the two connect in, both
        // end up knowing the other is present. The agent app is the one
        // that always initiates the actual WebRTC offer (see
        // remote-assist.html / remote-agent's main.js), triggered by
        // either of these two message types.
        send(room[otherRole], { type: 'peer-joined', role });
        if (room[otherRole]) send(ws, { type: 'peer-present', role: otherRole });

        ws.on('message', (data) => {
            // Signaling messages are opaque to this relay -- just forward
            // whatever the sending side put on the wire (SDP offer/answer,
            // ICE candidates, or either side's small "hello" with e.g. the
            // agent's real screen resolution) straight to the other side.
            send(room[otherRole], { type: 'signal', from: role, data: data.toString() });
        });

        ws.on('close', () => {
            if (room[role] === ws) room[role] = null;
            send(room[otherRole], { type: 'peer-left', role });
            cleanupRoom(code);
        });

        ws.on('error', () => {
            // 'close' fires right after -- nothing extra to do here beyond
            // not letting an unhandled error event crash the process.
        });
    });

    return wss;
}

// Forcibly disconnects both sides of a session (used by the staff
// member's "End session" button) so the live connection actually drops
// immediately instead of just leaving the database row stale until
// someone's socket happens to time out on its own.
function endSession(code) {
    const room = rooms.get((code || '').toUpperCase());
    if (!room) return;
    send(room.staff, { type: 'session-ended' });
    send(room.agent, { type: 'session-ended' });
    if (room.staff) try { room.staff.close(4000, 'Session ended.'); } catch (err) { /* already gone */ }
    if (room.agent) try { room.agent.close(4000, 'Session ended.'); } catch (err) { /* already gone */ }
    rooms.delete((code || '').toUpperCase());
}

module.exports = { attachSignaling, endSession };
