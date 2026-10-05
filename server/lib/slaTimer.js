// Background SLA sweep -- mirrors the CRM's lib/escalationTimer.js pattern:
// an in-process setInterval that (a) flags tickets whose resolution SLA has
// passed as breached and emails the assigned agent, and (b) sends a
// due-soon warning once per ticket using SLAWarningSentAt as the dedup
// flag and the configurable lead time from lib/settings.js.
const { sql, getPool } = require('../db/pool');
const { getSLAWarningHours, isAutoCloseResolvedEnabled, getAutoCloseResolvedHours } = require('./settings');
const { sendSLAWarningEmail, sendSLABreachedEmail, sendAutoClosedEmail } = require('./ticketEmails');

const OPEN_STATUSES = ['New', 'Open', 'Pending'];

async function sweepBreachedTickets(pool) {
    const result = await pool.request().query(`
        SELECT t.Id, t.TicketNumber, t.Subject, t.AssignedAgentId, u.Email AS AgentEmail
        FROM dbo.Tickets t
        LEFT JOIN dbo.Users u ON u.Id = t.AssignedAgentId
        WHERE t.Status IN ('New', 'Open', 'Pending')
          AND t.SLABreached = 0
          AND t.SLAResolutionDueAt IS NOT NULL
          AND t.SLAResolutionDueAt < SYSUTCDATETIME()
    `);
    for (const ticket of result.recordset) {
        await pool.request().input('id', sql.Int, ticket.Id)
            .query('UPDATE dbo.Tickets SET SLABreached = 1 WHERE Id = @id');
        if (ticket.AgentEmail) {
            await sendSLABreachedEmail(ticket.AgentEmail, {
                ticketId: ticket.Id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
            });
        }
    }
    return result.recordset.length;
}

async function sweepApproachingTickets(pool) {
    const warningHours = await getSLAWarningHours(pool);
    const result = await pool.request()
        .input('warningHours', sql.Float, warningHours)
        .query(`
            SELECT t.Id, t.TicketNumber, t.Subject, t.SLAResolutionDueAt, t.AssignedAgentId, u.Email AS AgentEmail
            FROM dbo.Tickets t
            LEFT JOIN dbo.Users u ON u.Id = t.AssignedAgentId
            WHERE t.Status IN ('New', 'Open', 'Pending')
              AND t.SLABreached = 0
              AND t.SLAWarningSentAt IS NULL
              AND t.SLAResolutionDueAt IS NOT NULL
              AND t.SLAResolutionDueAt BETWEEN SYSUTCDATETIME() AND DATEADD(MINUTE, @warningHours * 60, SYSUTCDATETIME())
        `);
    for (const ticket of result.recordset) {
        await pool.request().input('id', sql.Int, ticket.Id)
            .query('UPDATE dbo.Tickets SET SLAWarningSentAt = SYSUTCDATETIME() WHERE Id = @id');
        if (ticket.AgentEmail) {
            await sendSLAWarningEmail(ticket.AgentEmail, {
                ticketId: ticket.Id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
                dueAt: ticket.SLAResolutionDueAt,
            });
        }
    }
    return result.recordset.length;
}

// Auto-closes a ticket that's been sitting as Resolved for longer than
// getAutoCloseResolvedHours() (default 1 hour), and emails the requester
// saying it's been resolved and closed. A no-op (returns 0) when the
// AutoCloseResolvedEnabled setting is off. Reopening still works as
// normal afterwards -- a reply (web or email, via the [TicketNumber] tag
// in the subject -- see lib/emailInbound.js) on a Closed ticket resets it
// to Open regardless of how it got to Closed.
async function sweepAutoCloseResolvedTickets(pool) {
    if (!(await isAutoCloseResolvedEnabled(pool))) return 0;
    const hours = await getAutoCloseResolvedHours(pool);
    const result = await pool.request()
        .input('hours', sql.Float, hours)
        .query(`
            SELECT Id, TicketNumber, Subject, RequesterEmail
            FROM dbo.Tickets
            WHERE Status = 'Resolved'
              AND ResolvedAt IS NOT NULL
              AND DATEADD(MINUTE, @hours * 60, ResolvedAt) <= SYSUTCDATETIME()
        `);
    for (const ticket of result.recordset) {
        await pool.request().input('id', sql.Int, ticket.Id).query(`
            UPDATE dbo.Tickets SET Status = 'Closed', ClosedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
            WHERE Id = @id
        `);
        await sendAutoClosedEmail(ticket.RequesterEmail, {
            ticketId: ticket.Id, ticketNumber: ticket.TicketNumber, subject: ticket.Subject,
        });
    }
    return result.recordset.length;
}

async function runSweepOnce() {
    try {
        const pool = await getPool();
        const breached = await sweepBreachedTickets(pool);
        const warned = await sweepApproachingTickets(pool);
        const autoClosed = await sweepAutoCloseResolvedTickets(pool);
        if (breached || warned || autoClosed) {
            console.log(`SLA sweep: ${breached} newly breached, ${warned} due-soon warnings sent, ${autoClosed} auto-closed.`);
        }
    } catch (err) {
        console.error('SLA sweep failed:', err.message);
    }
}

// Starts the periodic sweep. First run is a few seconds after startup (so
// a fresh/empty database doesn't force every ticket through the full
// interval before the first check), then every intervalMinutes.
function startSlaTimer({ intervalMinutes = 5 } = {}) {
    setTimeout(runSweepOnce, 5000);
    const handle = setInterval(runSweepOnce, intervalMinutes * 60 * 1000);
    return handle;
}

module.exports = { startSlaTimer, runSweepOnce, sweepBreachedTickets, sweepApproachingTickets, sweepAutoCloseResolvedTickets };
