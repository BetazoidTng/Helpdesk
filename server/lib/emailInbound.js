// Inbound half of email-to-ticket: polls a support mailbox over IMAP,
// turns each new message into either a reply on an existing ticket (when
// its subject carries that ticket's [HD-123] tag -- the same tag every
// outbound notification in lib/ticketEmails.js includes) or a brand new
// ticket (when it doesn't). Mirrors the outbound side's "simply don't
// fire" fallback: with IMAP_HOST unset, polling never starts and nothing
// else in the app is affected.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sql, getPool } = require('../db/pool');
const { sendTicketCreatedEmail, sendNewReplyEmail } = require('./ticketEmails');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function isConfigured() {
    return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASSWORD);
}

function ticketNumberPattern() {
    const prefix = (process.env.TICKET_NUMBER_PREFIX || 'HD').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\[(${prefix}-\\d+)\\]`, 'i');
}

function extractTicketNumber(subject) {
    if (!subject) return null;
    const match = subject.match(ticketNumberPattern());
    return match ? match[1].toUpperCase() : null;
}

function plainTextBody(parsed) {
    if (parsed.text) return parsed.text.trim();
    if (parsed.html) return parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return '(empty message)';
}

async function saveInboundAttachments(pool, commentId, attachments) {
    for (const file of attachments || []) {
        if (!file.content || file.content.length === 0) continue;
        const storedName = `${crypto.randomBytes(16).toString('hex')}${path.extname(file.filename || '')}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, storedName), file.content);
        await pool.request()
            .input('commentId', sql.Int, commentId)
            .input('storedName', sql.NVarChar, storedName)
            .input('originalName', sql.NVarChar, file.filename || storedName)
            .input('mimeType', sql.NVarChar, file.contentType || 'application/octet-stream')
            .input('sizeBytes', sql.Int, file.content.length)
            .query(`
                INSERT INTO dbo.Attachments (TicketCommentId, StoredName, OriginalName, MimeType, SizeBytes)
                VALUES (@commentId, @storedName, @originalName, @mimeType, @sizeBytes)
            `);
    }
}

async function findUserByEmail(pool, email) {
    if (!email) return null;
    const result = await pool.request().input('email', sql.NVarChar, email)
        .query('SELECT Id, FullName, Role FROM dbo.Users WHERE Email = @email AND IsActive = 1');
    return result.recordset[0] || null;
}

async function appendReplyToTicket(pool, ticket, parsed, fromAddress, fromName) {
    const body = plainTextBody(parsed);
    const matchedUser = await findUserByEmail(pool, fromAddress);
    const authorId = matchedUser ? matchedUser.Id : null;
    const authorName = (matchedUser && matchedUser.FullName) || fromName || fromAddress;
    const isStaffReply = !!(matchedUser && (matchedUser.Role === 'Admin' || matchedUser.Role === 'Agent'));

    const commentResult = await pool.request()
        .input('ticketId', sql.Int, ticket.Id)
        .input('authorId', sql.Int, authorId)
        .input('authorName', sql.NVarChar, authorName)
        .input('authorEmail', sql.NVarChar, fromAddress)
        .input('body', sql.NVarChar, body)
        .input('messageId', sql.NVarChar, (parsed.messageId || '').slice(0, 255))
        .query(`
            INSERT INTO dbo.TicketComments (TicketId, AuthorId, AuthorName, AuthorEmail, Body, Source, MessageId)
            OUTPUT INSERTED.Id
            VALUES (@ticketId, @authorId, @authorName, @authorEmail, @body, 'Email', @messageId)
        `);
    const commentId = commentResult.recordset[0].Id;
    await saveInboundAttachments(pool, commentId, parsed.attachments);

    const reopening = !isStaffReply && ['Resolved', 'Closed'].includes(ticket.Status);
    const firstResponse = isStaffReply && !ticket.FirstRespondedAt;
    const newStatus = reopening ? 'Open' : (ticket.Status === 'New' && isStaffReply ? 'Open' : ticket.Status);

    await pool.request()
        .input('id', sql.Int, ticket.Id)
        .input('status', sql.NVarChar, newStatus)
        .input('firstRespondedAt', sql.DateTime2, firstResponse ? new Date() : ticket.FirstRespondedAt)
        .input('resolvedAt', sql.DateTime2, reopening ? null : ticket.ResolvedAt)
        .input('closedAt', sql.DateTime2, reopening ? null : ticket.ClosedAt)
        .query(`
            UPDATE dbo.Tickets SET
                Status = @status, FirstRespondedAt = @firstRespondedAt,
                ResolvedAt = @resolvedAt, ClosedAt = @closedAt, UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id
        `);

    if (isStaffReply) {
        await sendNewReplyEmail(ticket.RequesterEmail, {
            ticketId: ticket.Id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
            authorName, body,
        });
    } else if (ticket.AssignedAgentId) {
        const agentResult = await pool.request().input('id', sql.Int, ticket.AssignedAgentId)
            .query('SELECT Email FROM dbo.Users WHERE Id = @id');
        const agentEmail = agentResult.recordset[0] && agentResult.recordset[0].Email;
        await sendNewReplyEmail(agentEmail, {
            ticketId: ticket.Id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
            authorName, body,
        });
    }
}

async function createTicketFromEmail(pool, parsed, fromAddress, fromName) {
    // Deferred require avoids a require cycle at module load (tickets.js
    // doesn't need emailInbound.js, so this is one-directional, but is
    // kept lazy to keep that explicit).
    const { computeSlaDueDates, ticketNumberFor } = require('../routes/tickets');

    const subject = (parsed.subject || '(no subject)').trim();
    const body = plainTextBody(parsed);
    const matchedUser = await findUserByEmail(pool, fromAddress);
    const requesterId = matchedUser ? matchedUser.Id : null;
    const requesterName = (matchedUser && matchedUser.FullName) || fromName || fromAddress;

    const { responseDueAt, resolutionDueAt } = await computeSlaDueDates(pool, 'Medium');

    const insertResult = await pool.request()
        .input('subject', sql.NVarChar, subject)
        .input('requesterId', sql.Int, requesterId)
        .input('requesterName', sql.NVarChar, requesterName)
        .input('requesterEmail', sql.NVarChar, fromAddress)
        .input('responseDueAt', sql.DateTime2, responseDueAt)
        .input('resolutionDueAt', sql.DateTime2, resolutionDueAt)
        .query(`
            INSERT INTO dbo.Tickets
                (Subject, Priority, RequesterId, RequesterName, RequesterEmail, Source,
                 SLAResponseDueAt, SLAResolutionDueAt)
            OUTPUT INSERTED.Id
            VALUES (@subject, 'Medium', @requesterId, @requesterName, @requesterEmail, 'Email',
                    @responseDueAt, @resolutionDueAt)
        `);
    const ticketId = insertResult.recordset[0].Id;
    const ticketNumber = ticketNumberFor(ticketId);

    await pool.request()
        .input('id', sql.Int, ticketId)
        .input('ticketNumber', sql.NVarChar, ticketNumber)
        .query('UPDATE dbo.Tickets SET TicketNumber = @ticketNumber WHERE Id = @id');

    const commentResult = await pool.request()
        .input('ticketId', sql.Int, ticketId)
        .input('authorId', sql.Int, requesterId)
        .input('authorName', sql.NVarChar, requesterName)
        .input('authorEmail', sql.NVarChar, fromAddress)
        .input('body', sql.NVarChar, body)
        .input('messageId', sql.NVarChar, (parsed.messageId || '').slice(0, 255))
        .query(`
            INSERT INTO dbo.TicketComments (TicketId, AuthorId, AuthorName, AuthorEmail, Body, Source, MessageId)
            OUTPUT INSERTED.Id
            VALUES (@ticketId, @authorId, @authorName, @authorEmail, @body, 'Email', @messageId)
        `);
    await saveInboundAttachments(pool, commentResult.recordset[0].Id, parsed.attachments);

    await sendTicketCreatedEmail(fromAddress, { ticketId, ticketNumber, subject });
}

async function handleParsedMessage(pool, parsed) {
    const fromEntry = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
    const fromAddress = (fromEntry.address || '').toLowerCase();
    const fromName = fromEntry.name || '';
    if (!fromAddress) return;

    const ticketNumber = extractTicketNumber(parsed.subject);
    if (ticketNumber) {
        const result = await pool.request().input('ticketNumber', sql.NVarChar, ticketNumber)
            .query('SELECT * FROM dbo.Tickets WHERE TicketNumber = @ticketNumber');
        const ticket = result.recordset[0];
        if (ticket) {
            await appendReplyToTicket(pool, ticket, parsed, fromAddress, fromName);
            return;
        }
        // Tag looked like one of ours but didn't match any ticket -- fall
        // through and treat it as a new ticket rather than dropping it.
    }
    await createTicketFromEmail(pool, parsed, fromAddress, fromName);
}

// A single poll: connects, fetches unseen messages, hands each to
// handleParsedMessage, flags it seen, disconnects. Swallows its own
// errors so one bad poll never takes down the interval timer.
async function pollOnce() {
    if (!isConfigured()) return;

    // Deferred requires: imapflow/mailparser are only needed when IMAP is
    // actually configured, so a Helpdesk install that never sets IMAP_HOST
    // never needs those packages installed at all.
    const { ImapFlow } = require('imapflow');
    const { simpleParser } = require('mailparser');

    const client = new ImapFlow({
        host: process.env.IMAP_HOST,
        port: parseInt(process.env.IMAP_PORT || '993', 10),
        secure: process.env.IMAP_SECURE !== 'false',
        auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASSWORD },
        logger: false,
    });

    try {
        await client.connect();
        const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || 'INBOX');
        try {
            const pool = await getPool();
            for await (const message of client.fetch({ seen: false }, { source: true, uid: true })) {
                try {
                    const parsed = await simpleParser(message.source);
                    await handleParsedMessage(pool, parsed);
                    await client.messageFlagsAdd(message.uid, ['\\Seen'], { uid: true });
                } catch (err) {
                    console.error('Failed to process one inbound email (leaving it unseen):', err.message);
                }
            }
        } finally {
            lock.release();
        }
    } catch (err) {
        console.error('IMAP poll failed:', err.message);
    } finally {
        try { await client.logout(); } catch (_) { /* already disconnected */ }
    }
}

// Starts the periodic inbox poll. No-op (returns null) when IMAP isn't
// configured, same fallback style as lib/mailer.js's SMTP_HOST gate.
function startEmailInboundPolling() {
    if (!isConfigured()) {
        console.log('Email-to-ticket not started (IMAP_HOST/IMAP_USER/IMAP_PASSWORD not set) -- inbound email disabled.');
        return null;
    }
    const seconds = parseInt(process.env.IMAP_POLL_SECONDS || '60', 10);
    console.log(`Email-to-ticket polling ${process.env.IMAP_MAILBOX || 'INBOX'} every ${seconds}s.`);
    pollOnce();
    return setInterval(pollOnce, seconds * 1000);
}

module.exports = { startEmailInboundPolling, pollOnce, extractTicketNumber };
