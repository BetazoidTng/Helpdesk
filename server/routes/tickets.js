// Ticket CRUD, the comment thread (the first comment IS the ticket's
// description -- see db/schema.sql), assignment, SLA due-date computation,
// and attachment upload/view/download. Modeled directly on the CRM's
// server/routes/callsheets.js escalation pattern, adapted for tickets.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { sql, getPool } = require('../db/pool');
const { requireAuth, requireStaff, isStaffUser } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');
const {
    sendTicketCreatedEmail,
    sendNewReplyEmail,
    sendAssignedEmail,
    sendResolvedEmail,
} = require('../lib/ticketEmails');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').slice(0, 20);
            cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
        },
    }),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 },
});

const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const STATUSES = ['New', 'Open', 'Pending', 'Resolved', 'Closed'];

function ticketNumberFor(id) {
    const prefix = process.env.TICKET_NUMBER_PREFIX || 'HD';
    return `${prefix}-${id}`;
}

async function computeSlaDueDates(pool, priority, fromDate) {
    const result = await pool.request()
        .input('priority', sql.NVarChar, priority)
        .query('SELECT ResponseHours, ResolutionHours FROM dbo.SLAPolicies WHERE Priority = @priority');
    const policy = result.recordset[0] || { ResponseHours: 4, ResolutionHours: 24 };
    const from = fromDate ? new Date(fromDate) : new Date();
    return {
        responseDueAt: new Date(from.getTime() + policy.ResponseHours * 3600 * 1000),
        resolutionDueAt: new Date(from.getTime() + policy.ResolutionHours * 3600 * 1000),
    };
}

// A Requester may only ever see their own tickets, whatever filters they
// send; Staff (Admin/Agent) can see everything and filter freely.
function applyVisibility(request, where, user) {
    if (!isStaffUser(user)) {
        where.push('(t.RequesterId = @meId OR t.RequesterEmail = @meEmail)');
        request.input('meId', sql.Int, user.id);
        request.input('meEmail', sql.NVarChar, user.email);
    }
}

async function loadTicketAttachmentsByComment(pool, commentIds) {
    if (commentIds.length === 0) return {};
    const result = await pool.request().query(`
        SELECT Id, TicketCommentId, OriginalName, MimeType, SizeBytes, CreatedAt
        FROM dbo.Attachments
        WHERE TicketCommentId IN (${commentIds.join(',')})
        ORDER BY CreatedAt ASC
    `);
    const byComment = {};
    for (const row of result.recordset) {
        (byComment[row.TicketCommentId] = byComment[row.TicketCommentId] || []).push(row);
    }
    return byComment;
}

// GET /api/tickets -- list, filterable. Staff see everything by default;
// Requesters always see only their own regardless of filters sent.
router.get('/', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const user = req.session.user;
        const request = pool.request();
        const where = [];

        applyVisibility(request, where, user);

        if (req.query.status && STATUSES.includes(req.query.status)) {
            where.push('t.Status = @status');
            request.input('status', sql.NVarChar, req.query.status);
        }
        if (req.query.priority && PRIORITIES.includes(req.query.priority)) {
            where.push('t.Priority = @priority');
            request.input('priority', sql.NVarChar, req.query.priority);
        }
        if (req.query.categoryId) {
            where.push('t.CategoryId = @categoryId');
            request.input('categoryId', sql.Int, parseInt(req.query.categoryId, 10));
        }
        if (isStaffUser(user) && req.query.assigned === 'me') {
            where.push('t.AssignedAgentId = @me');
            request.input('me', sql.Int, user.id);
        } else if (isStaffUser(user) && req.query.assigned === 'unassigned') {
            where.push('t.AssignedAgentId IS NULL');
        }
        if (req.query.search) {
            where.push('(t.Subject LIKE @search OR t.TicketNumber LIKE @search)');
            request.input('search', sql.NVarChar, `%${req.query.search}%`);
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const result = await request.query(`
            SELECT TOP 200
                t.Id, t.TicketNumber, t.Subject, t.Priority, t.Status, t.Source,
                t.CategoryId, c.Name AS CategoryName,
                t.RequesterId, t.RequesterName, t.RequesterEmail,
                t.AssignedAgentId, u.FullName AS AssignedAgentName,
                t.CreatedAt, t.UpdatedAt, t.SLAResolutionDueAt, t.SLABreached
            FROM dbo.Tickets t
            LEFT JOIN dbo.Categories c ON c.Id = t.CategoryId
            LEFT JOIN dbo.Users u ON u.Id = t.AssignedAgentId
            ${whereClause}
            ORDER BY t.CreatedAt DESC
        `);
        res.json({ tickets: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load tickets.' });
    }
});

// GET /api/tickets/meta/agents -- Admins/Agents list, for the assignment
// dropdown. Two path segments, so it never collides with GET /:id below.
router.get('/meta/agents', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT Id, FullName FROM dbo.Users
            WHERE Role IN ('Admin', 'Agent') AND IsActive = 1
            ORDER BY FullName ASC
        `);
        res.json({ agents: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load agents.' });
    }
});

// GET /api/tickets/:id -- full detail: ticket + comment thread + attachments.
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const user = req.session.user;
        const id = parseInt(req.params.id, 10);

        const ticketResult = await pool.request()
            .input('id', sql.Int, id)
            .query(`
                SELECT t.*, c.Name AS CategoryName, u.FullName AS AssignedAgentName
                FROM dbo.Tickets t
                LEFT JOIN dbo.Categories c ON c.Id = t.CategoryId
                LEFT JOIN dbo.Users u ON u.Id = t.AssignedAgentId
                WHERE t.Id = @id
            `);
        const ticket = ticketResult.recordset[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

        const staff = isStaffUser(user);
        const owns = ticket.RequesterId === user.id || (ticket.RequesterEmail && ticket.RequesterEmail === user.email);
        if (!staff && !owns) return res.status(403).json({ error: "You don't have access to this ticket." });

        const commentsResult = await pool.request()
            .input('ticketId', sql.Int, id)
            .query(`
                SELECT Id, AuthorId, AuthorName, AuthorEmail, Body, IsInternalNote, Source, CreatedAt
                FROM dbo.TicketComments
                WHERE TicketId = @ticketId
                ${staff ? '' : 'AND IsInternalNote = 0'}
                ORDER BY CreatedAt ASC
            `);
        const comments = commentsResult.recordset;
        const attachmentsByComment = await loadTicketAttachmentsByComment(pool, comments.map((c) => c.Id));
        for (const comment of comments) {
            comment.attachments = attachmentsByComment[comment.Id] || [];
        }

        res.json({ ticket, comments });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load ticket.' });
    }
});

// POST /api/tickets -- create a ticket. A Requester creates one for
// themselves; Staff can create one on a requester's behalf by name/email.
router.post('/', requireAuth, upload.array('attachments', 5), async (req, res) => {
    try {
        const pool = await getPool();
        const user = req.session.user;
        const { subject, description, categoryId, priority } = req.body;

        if (!subject || !description) {
            return res.status(400).json({ error: 'Subject and description are required.' });
        }
        const chosenPriority = PRIORITIES.includes(priority) ? priority : 'Medium';

        let requesterId = user.id;
        let requesterName = user.fullName;
        let requesterEmail = user.email;
        if (isStaffUser(user) && req.body.requesterEmail) {
            requesterId = null;
            requesterName = req.body.requesterName || req.body.requesterEmail;
            requesterEmail = req.body.requesterEmail;
        }

        const { responseDueAt, resolutionDueAt } = await computeSlaDueDates(pool, chosenPriority);

        const insertResult = await pool.request()
            .input('subject', sql.NVarChar, subject)
            .input('categoryId', sql.Int, categoryId ? parseInt(categoryId, 10) : null)
            .input('priority', sql.NVarChar, chosenPriority)
            .input('requesterId', sql.Int, requesterId)
            .input('requesterName', sql.NVarChar, requesterName)
            .input('requesterEmail', sql.NVarChar, requesterEmail)
            .input('responseDueAt', sql.DateTime2, responseDueAt)
            .input('resolutionDueAt', sql.DateTime2, resolutionDueAt)
            .query(`
                INSERT INTO dbo.Tickets
                    (Subject, CategoryId, Priority, RequesterId, RequesterName, RequesterEmail,
                     SLAResponseDueAt, SLAResolutionDueAt)
                OUTPUT INSERTED.Id
                VALUES
                    (@subject, @categoryId, @priority, @requesterId, @requesterName, @requesterEmail,
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
            .input('authorEmail', sql.NVarChar, requesterEmail)
            .input('body', sql.NVarChar, description)
            .query(`
                INSERT INTO dbo.TicketComments (TicketId, AuthorId, AuthorName, AuthorEmail, Body)
                OUTPUT INSERTED.Id
                VALUES (@ticketId, @authorId, @authorName, @authorEmail, @body)
            `);
        const commentId = commentResult.recordset[0].Id;

        await saveAttachments(pool, commentId, req.files);

        await logAudit(pool, {
            userId: user.id,
            action: 'Create',
            entityType: 'Ticket',
            entityId: ticketId,
            summary: `Created ticket ${ticketNumber}: ${subject}`,
        });

        sendTicketCreatedEmail(requesterEmail, { ticketId, ticketNumber, subject });

        res.status(201).json({ id: ticketId, ticketNumber });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create ticket.' });
    }
});

async function saveAttachments(pool, commentId, files) {
    if (!files || files.length === 0) return;
    for (const file of files) {
        await pool.request()
            .input('commentId', sql.Int, commentId)
            .input('storedName', sql.NVarChar, file.filename)
            .input('originalName', sql.NVarChar, file.originalname)
            .input('mimeType', sql.NVarChar, file.mimetype)
            .input('sizeBytes', sql.Int, file.size)
            .query(`
                INSERT INTO dbo.Attachments (TicketCommentId, StoredName, OriginalName, MimeType, SizeBytes)
                VALUES (@commentId, @storedName, @originalName, @mimeType, @sizeBytes)
            `);
    }
}

// PUT /api/tickets/:id -- Staff-only: subject/category/priority/status/assignment.
router.put('/:id', requireStaff, async (req, res) => {
    try {
        const pool = await getPool();
        const id = parseInt(req.params.id, 10);
        const user = req.session.user;

        const existingResult = await pool.request().input('id', sql.Int, id)
            .query('SELECT * FROM dbo.Tickets WHERE Id = @id');
        const existing = existingResult.recordset[0];
        if (!existing) return res.status(404).json({ error: 'Ticket not found.' });

        const subject = req.body.subject || existing.Subject;
        const categoryId = req.body.categoryId !== undefined ? (req.body.categoryId ? parseInt(req.body.categoryId, 10) : null) : existing.CategoryId;
        const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : existing.Priority;
        const status = STATUSES.includes(req.body.status) ? req.body.status : existing.Status;
        const assignedAgentId = req.body.assignedAgentId !== undefined
            ? (req.body.assignedAgentId ? parseInt(req.body.assignedAgentId, 10) : null)
            : existing.AssignedAgentId;

        const priorityChanged = priority !== existing.Priority;
        let responseDueAt = existing.SLAResponseDueAt;
        let resolutionDueAt = existing.SLAResolutionDueAt;
        if (priorityChanged) {
            const dueDates = await computeSlaDueDates(pool, priority, existing.CreatedAt);
            responseDueAt = dueDates.responseDueAt;
            resolutionDueAt = dueDates.resolutionDueAt;
        }

        const resolvedAt = status === 'Resolved' && existing.Status !== 'Resolved' ? new Date() : existing.ResolvedAt;
        const closedAt = status === 'Closed' && existing.Status !== 'Closed' ? new Date() : existing.ClosedAt;
        const reopening = ['Resolved', 'Closed'].includes(existing.Status) && !['Resolved', 'Closed'].includes(status);

        await pool.request()
            .input('id', sql.Int, id)
            .input('subject', sql.NVarChar, subject)
            .input('categoryId', sql.Int, categoryId)
            .input('priority', sql.NVarChar, priority)
            .input('status', sql.NVarChar, status)
            .input('assignedAgentId', sql.Int, assignedAgentId)
            .input('responseDueAt', sql.DateTime2, responseDueAt)
            .input('resolutionDueAt', sql.DateTime2, resolutionDueAt)
            .input('slaWarningSentAt', sql.DateTime2, priorityChanged ? null : existing.SLAWarningSentAt)
            .input('slaBreached', sql.Bit, priorityChanged ? 0 : existing.SLABreached)
            .input('resolvedAt', sql.DateTime2, reopening ? null : resolvedAt)
            .input('closedAt', sql.DateTime2, reopening ? null : closedAt)
            .query(`
                UPDATE dbo.Tickets SET
                    Subject = @subject, CategoryId = @categoryId, Priority = @priority,
                    Status = @status, AssignedAgentId = @assignedAgentId,
                    SLAResponseDueAt = @responseDueAt, SLAResolutionDueAt = @resolutionDueAt,
                    SLAWarningSentAt = @slaWarningSentAt, SLABreached = @slaBreached,
                    ResolvedAt = @resolvedAt, ClosedAt = @closedAt,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE Id = @id
            `);

        await logAudit(pool, {
            userId: user.id,
            action: 'Update',
            entityType: 'Ticket',
            entityId: id,
            summary: `Updated ticket ${existing.TicketNumber}`,
        });

        if (assignedAgentId && assignedAgentId !== existing.AssignedAgentId) {
            const agentResult = await pool.request().input('id', sql.Int, assignedAgentId)
                .query('SELECT Email FROM dbo.Users WHERE Id = @id');
            const agentEmail = agentResult.recordset[0] && agentResult.recordset[0].Email;
            sendAssignedEmail(agentEmail, { ticketId: id, ticketNumber: existing.TicketNumber, subject, priority });
        }
        if (status === 'Resolved' && existing.Status !== 'Resolved') {
            sendResolvedEmail(existing.RequesterEmail, { ticketId: id, ticketNumber: existing.TicketNumber, subject });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update ticket.' });
    }
});

// POST /api/tickets/:id/comments -- add a reply (public) or internal note
// (Staff only). Reopens a Resolved/Closed ticket when the Requester replies.
router.post('/:id/comments', requireAuth, upload.array('attachments', 5), async (req, res) => {
    try {
        const pool = await getPool();
        const user = req.session.user;
        const id = parseInt(req.params.id, 10);
        const { body } = req.body;
        const isInternalNote = req.body.isInternalNote === 'true' || req.body.isInternalNote === true;

        if (!body) return res.status(400).json({ error: 'A comment body is required.' });

        const ticketResult = await pool.request().input('id', sql.Int, id)
            .query('SELECT * FROM dbo.Tickets WHERE Id = @id');
        const ticket = ticketResult.recordset[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

        const staff = isStaffUser(user);
        const owns = ticket.RequesterId === user.id || (ticket.RequesterEmail && ticket.RequesterEmail === user.email);
        if (!staff && !owns) return res.status(403).json({ error: "You don't have access to this ticket." });
        if (!staff && isInternalNote) return res.status(403).json({ error: 'Only an Admin or Agent can add an internal note.' });

        const commentResult = await pool.request()
            .input('ticketId', sql.Int, id)
            .input('authorId', sql.Int, user.id)
            .input('authorName', sql.NVarChar, user.fullName)
            .input('authorEmail', sql.NVarChar, user.email)
            .input('body', sql.NVarChar, body)
            .input('isInternalNote', sql.Bit, isInternalNote ? 1 : 0)
            .query(`
                INSERT INTO dbo.TicketComments (TicketId, AuthorId, AuthorName, AuthorEmail, Body, IsInternalNote)
                OUTPUT INSERTED.Id
                VALUES (@ticketId, @authorId, @authorName, @authorEmail, @body, @isInternalNote)
            `);
        const commentId = commentResult.recordset[0].Id;
        await saveAttachments(pool, commentId, req.files);

        const reopening = !isInternalNote && !staff && ['Resolved', 'Closed'].includes(ticket.Status);
        const firstResponse = staff && !isInternalNote && !ticket.FirstRespondedAt;
        const newStatus = reopening ? 'Open' : (ticket.Status === 'New' && staff ? 'Open' : ticket.Status);

        await pool.request()
            .input('id', sql.Int, id)
            .input('status', sql.NVarChar, newStatus)
            .input('firstRespondedAt', sql.DateTime2, firstResponse ? new Date() : ticket.FirstRespondedAt)
            .input('resolvedAt', sql.DateTime2, reopening ? null : ticket.ResolvedAt)
            .input('closedAt', sql.DateTime2, reopening ? null : ticket.ClosedAt)
            .query(`
                UPDATE dbo.Tickets SET
                    Status = @status, FirstRespondedAt = @firstRespondedAt,
                    ResolvedAt = @resolvedAt, ClosedAt = @closedAt,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE Id = @id
            `);

        if (!isInternalNote) {
            if (staff) {
                sendNewReplyEmail(ticket.RequesterEmail, {
                    ticketId: id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
                    authorName: user.fullName, body,
                });
            } else if (ticket.AssignedAgentId) {
                const agentResult = await pool.request().input('id', sql.Int, ticket.AssignedAgentId)
                    .query('SELECT Email FROM dbo.Users WHERE Id = @id');
                const agentEmail = agentResult.recordset[0] && agentResult.recordset[0].Email;
                sendNewReplyEmail(agentEmail, {
                    ticketId: id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
                    authorName: user.fullName, body,
                });
            }
        }

        res.status(201).json({ id: commentId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to add comment.' });
    }
});

async function loadAttachmentForAccess(pool, attachmentId, user) {
    const result = await pool.request().input('id', sql.Int, attachmentId).query(`
        SELECT a.Id, a.StoredName, a.OriginalName, a.MimeType, tc.IsInternalNote, tc.TicketId, tc.AuthorId,
               t.RequesterId, t.RequesterEmail
        FROM dbo.Attachments a
        JOIN dbo.TicketComments tc ON tc.Id = a.TicketCommentId
        JOIN dbo.Tickets t ON t.Id = tc.TicketId
        WHERE a.Id = @id
    `);
    const row = result.recordset[0];
    if (!row) return null;
    const staff = isStaffUser(user);
    const owns = row.RequesterId === user.id || (row.RequesterEmail && row.RequesterEmail === user.email);
    if (!staff && !owns) return { forbidden: true };
    if (!staff && row.IsInternalNote) return { forbidden: true };
    return row;
}

// GET /api/tickets/attachments/:attachmentId/view -- inline preview.
router.get('/attachments/:attachmentId/view', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const row = await loadAttachmentForAccess(pool, parseInt(req.params.attachmentId, 10), req.session.user);
        if (!row) return res.status(404).json({ error: 'Attachment not found.' });
        if (row.forbidden) return res.status(403).json({ error: "You don't have access to this file." });
        const filePath = path.join(UPLOAD_DIR, row.StoredName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File is missing on disk.' });
        res.setHeader('Content-Type', row.MimeType || 'application/octet-stream');
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to open attachment.' });
    }
});

// GET /api/tickets/attachments/:attachmentId/download -- forces download.
router.get('/attachments/:attachmentId/download', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const row = await loadAttachmentForAccess(pool, parseInt(req.params.attachmentId, 10), req.session.user);
        if (!row) return res.status(404).json({ error: 'Attachment not found.' });
        if (row.forbidden) return res.status(403).json({ error: "You don't have access to this file." });
        const filePath = path.join(UPLOAD_DIR, row.StoredName);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File is missing on disk.' });
        res.setHeader('Content-Type', row.MimeType || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${row.OriginalName.replace(/"/g, '')}"`);
        fs.createReadStream(filePath).pipe(res);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to download attachment.' });
    }
});

// DELETE /api/tickets/attachments/:attachmentId -- remove an attachment
// (e.g. the wrong screenshot got uploaded). Staff can delete any
// attachment; a Requester can only delete one they uploaded themselves
// (AuthorId on the comment it's attached to), and never one on an
// internal note, same visibility rule as view/download. An attachment
// that arrived by email has no AuthorId, so only Staff can remove those.
router.delete('/attachments/:attachmentId', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const user = req.session.user;
        const attachmentId = parseInt(req.params.attachmentId, 10);
        const row = await loadAttachmentForAccess(pool, attachmentId, user);
        if (!row) return res.status(404).json({ error: 'Attachment not found.' });
        if (row.forbidden) return res.status(403).json({ error: "You don't have access to this file." });

        const staff = isStaffUser(user);
        const uploadedByMe = row.AuthorId != null && row.AuthorId === user.id;
        if (!staff && !uploadedByMe) {
            return res.status(403).json({ error: 'You can only delete a file you uploaded yourself.' });
        }

        await pool.request().input('id', sql.Int, attachmentId).query('DELETE FROM dbo.Attachments WHERE Id = @id');
        const filePath = path.join(UPLOAD_DIR, row.StoredName);
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') console.error('Failed to remove attachment file from disk:', err.message);
        });

        await logAudit(pool, {
            userId: user.id,
            action: 'Delete',
            entityType: 'Attachment',
            entityId: attachmentId,
            summary: `Deleted attachment "${row.OriginalName}" from ticket #${row.TicketId}`,
        });

        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete attachment.' });
    }
});

module.exports = router;
module.exports.computeSlaDueDates = computeSlaDueDates;
module.exports.ticketNumberFor = ticketNumberFor;
