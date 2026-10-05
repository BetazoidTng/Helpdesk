// REST side of Remote Assist -- creating and ending a session. The
// actual screen/control connection is a direct WebRTC link between the
// staff member's browser and the customer's agent app; this route only
// issues the short join Code that pairs the two of them on the
// signaling relay (see server/lib/remoteAssistSignaling.js). Staff only
// -- the join Code itself is what lets the (anonymous, unauthenticated)
// customer-side agent app connect.
const express = require('express');
const crypto = require('crypto');
const { sql, getPool } = require('../db/pool');
const { requireStaff } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const { endSession } = require('../lib/remoteAssistSignaling');

const router = express.Router();
router.use(requireStaff);

// Unambiguous characters only (no 0/O, 1/I/L) -- this gets read aloud
// over the phone or typed in by someone who isn't technical, so it
// should survive that.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(length = 6) {
    let code = '';
    for (let i = 0; i < length; i++) {
        code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    return code;
}

// POST /api/remote-assist/sessions -- { ticketId }
router.post('/sessions', async (req, res) => {
    try {
        const ticketId = parseInt(req.body.ticketId, 10);
        if (!ticketId) return res.status(400).json({ error: 'ticketId is required.' });

        const pool = await getPool();
        const ticketResult = await pool.request().input('id', sql.Int, ticketId)
            .query('SELECT Id, TicketNumber FROM dbo.Tickets WHERE Id = @id');
        const ticket = ticketResult.recordset[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

        // Collisions are astronomically unlikely at 6 characters from a
        // 32-symbol alphabet (~1 billion combinations), but Code is
        // UNIQUE, so just retry on the rare clash rather than pre-checking.
        let session = null;
        for (let attempt = 0; attempt < 5 && !session; attempt++) {
            const code = generateCode();
            try {
                const result = await pool.request()
                    .input('ticketId', sql.Int, ticketId)
                    .input('code', sql.NVarChar, code)
                    .input('createdById', sql.Int, req.session.user.id)
                    .query(`
                        INSERT INTO dbo.RemoteSessions (TicketId, Code, CreatedById)
                        OUTPUT INSERTED.Id, INSERTED.Code, INSERTED.Status, INSERTED.CreatedAt
                        VALUES (@ticketId, @code, @createdById)
                    `);
                session = result.recordset[0];
            } catch (err) {
                if (!/unique|duplicate/i.test(err.message || '')) throw err;
                // else: code collision, loop and try another
            }
        }
        if (!session) return res.status(500).json({ error: 'Could not generate a unique session code -- try again.' });

        await logAudit(pool, {
            userId: req.session.user.id,
            action: 'Create',
            entityType: 'RemoteSession',
            entityId: session.Id,
            summary: `Started a remote assist session for ticket ${ticket.TicketNumber}`,
        });

        res.status(201).json({
            id: session.Id, code: session.Code, status: session.Status,
            ticketId, ticketNumber: ticket.TicketNumber,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to start a remote assist session.' });
    }
});

// GET /api/remote-assist/sessions/:id -- for the staff viewer to poll
// while waiting for the customer's agent app to join.
router.get('/sessions/:id', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().input('id', sql.Int, parseInt(req.params.id, 10))
            .query('SELECT Id, TicketId, Code, Status, CreatedAt, ConnectedAt, EndedAt FROM dbo.RemoteSessions WHERE Id = @id');
        const session = result.recordset[0];
        if (!session) return res.status(404).json({ error: 'Session not found.' });
        res.json({ session });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load session.' });
    }
});

// POST /api/remote-assist/sessions/:id/end -- drops the live connection
// (if any) immediately and marks the session Ended so its code can never
// be joined again.
router.post('/sessions/:id/end', async (req, res) => {
    try {
        const pool = await getPool();
        const id = parseInt(req.params.id, 10);
        const result = await pool.request().input('id', sql.Int, id)
            .query('SELECT Id, Code, TicketId, Status FROM dbo.RemoteSessions WHERE Id = @id');
        const session = result.recordset[0];
        if (!session) return res.status(404).json({ error: 'Session not found.' });

        await pool.request().input('id', sql.Int, id).query(`
            UPDATE dbo.RemoteSessions SET Status = 'Ended', EndedAt = SYSUTCDATETIME() WHERE Id = @id
        `);
        endSession(session.Code);

        await logAudit(pool, {
            userId: req.session.user.id,
            action: 'Update',
            entityType: 'RemoteSession',
            entityId: id,
            summary: `Ended remote assist session for ticket #${session.TicketId}`,
        });

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to end session.' });
    }
});

module.exports = router;
