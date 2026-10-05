// Every notification email this app sends -- ticket created, a new reply,
// assigned to an agent, SLA due-soon warning, SLA breached, and resolved.
// Every subject includes the ticket's [TicketNumber] tag so a reply to any
// of these threads back into the right ticket via
// server/lib/emailInbound.js.
const { sendMail } = require('./mailer');

function appLink(ticketId) {
    const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    if (!base) return null;
    return `${base}/ticket.html?id=${ticketId}`;
}

function wrap(bodyHtml) {
    return `<div style="font-family: Arial, Helvetica, sans-serif; max-width: 560px; margin: 0 auto; color:#1a1a1a;">${bodyHtml}</div>`;
}

function linkLine(ticketId) {
    const link = appLink(ticketId);
    return link ? `<p><a href="${link}" style="color:#1a56db;">Open this ticket</a></p>` : '';
}

async function sendSafely(to, build, logLabel, ticketId) {
    if (!to) return;
    try {
        const email = build();
        await sendMail({ to, ...email });
    } catch (err) {
        console.error(`Failed to send ${logLabel} email for ticket ${ticketId}:`, err.message);
    }
}

function sendTicketCreatedEmail(to, { ticketId, ticketNumber, subject }) {
    return sendSafely(to, () => {
        const html = wrap(`
            <h2>We've got your request</h2>
            <p><strong>${ticketNumber}</strong>: ${subject}</p>
            <p>We'll email you as soon as someone replies. You can also check progress any time by logging in.</p>
            ${linkLine(ticketId)}
        `);
        const text = [`We've got your request`, `${ticketNumber}: ${subject}`, "We'll email you as soon as someone replies.", appLink(ticketId)].filter(Boolean).join('\n');
        return { subject: `[${ticketNumber}] ${subject}`, html, text };
    }, 'ticket-created', ticketId);
}

function sendNewReplyEmail(to, { ticketId, ticketNumber, subject, authorName, body }) {
    return sendSafely(to, () => {
        const html = wrap(`
            <h2>New reply on ${ticketNumber}</h2>
            <p><strong>${authorName || 'Someone'}</strong> replied:</p>
            <p style="white-space:pre-wrap;border-left:3px solid #d7e3f0;padding-left:12px;">${body}</p>
            ${linkLine(ticketId)}
        `);
        const text = [`New reply on ${ticketNumber}`, `${authorName || 'Someone'} replied:`, body, appLink(ticketId)].filter(Boolean).join('\n');
        return { subject: `[${ticketNumber}] ${subject}`, html, text };
    }, 'new-reply', ticketId);
}

function sendAssignedEmail(to, { ticketId, ticketNumber, subject, priority }) {
    return sendSafely(to, () => {
        const html = wrap(`
            <h2>A ticket has been assigned to you</h2>
            <p><strong>${ticketNumber}</strong>: ${subject}</p>
            <p>Priority: <strong>${priority}</strong></p>
            ${linkLine(ticketId)}
        `);
        const text = [`A ticket has been assigned to you`, `${ticketNumber}: ${subject}`, `Priority: ${priority}`, appLink(ticketId)].filter(Boolean).join('\n');
        return { subject: `Assigned to you: [${ticketNumber}] ${subject}`, html, text };
    }, 'assigned', ticketId);
}

function sendSLAWarningEmail(to, { ticketId, ticketNumber, subject, dueAt }) {
    return sendSafely(to, () => {
        const dueString = new Date(dueAt).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
        const html = wrap(`
            <h2>Heads up -- this ticket's SLA is due soon</h2>
            <p><strong>${ticketNumber}</strong>: ${subject}</p>
            <p>Due by <strong>${dueString}</strong>, or it will be flagged as an SLA breach.</p>
            ${linkLine(ticketId)}
        `);
        const text = [`Heads up -- this ticket's SLA is due soon`, `${ticketNumber}: ${subject}`, `Due by ${dueString}.`, appLink(ticketId)].filter(Boolean).join('\n');
        return { subject: `Due soon: [${ticketNumber}] ${subject}`, html, text };
    }, 'sla-warning', ticketId);
}

function sendSLABreachedEmail(to, { ticketId, ticketNumber, subject }) {
    return sendSafely(to, () => {
        const html = wrap(`
            <h2>SLA breached</h2>
            <p><strong>${ticketNumber}</strong>: ${subject}</p>
            <p>This ticket's resolution SLA has run out without being resolved.</p>
            ${linkLine(ticketId)}
        `);
        const text = [`SLA breached`, `${ticketNumber}: ${subject}`, "This ticket's resolution SLA has run out without being resolved.", appLink(ticketId)].filter(Boolean).join('\n');
        return { subject: `SLA BREACHED: [${ticketNumber}] ${subject}`, html, text };
    }, 'sla-breached', ticketId);
}

function sendResolvedEmail(to, { ticketId, ticketNumber, subject }) {
    return sendSafely(to, () => {
        const html = wrap(`
            <h2>Your request has been resolved</h2>
            <p><strong>${ticketNumber}</strong>: ${subject}</p>
            <p>If this didn't actually fix things, just reply to this email (or reopen it in the portal) and it'll come straight back to us.</p>
            ${linkLine(ticketId)}
        `);
        const text = [`Your request has been resolved`, `${ticketNumber}: ${subject}`, "If this didn't actually fix things, just reply and it'll come straight back to us.", appLink(ticketId)].filter(Boolean).join('\n');
        return { subject: `Resolved: [${ticketNumber}] ${subject}`, html, text };
    }, 'resolved', ticketId);
}

function sendAutoClosedEmail(to, { ticketId, ticketNumber, subject }) {
    return sendSafely(to, () => {
        const html = wrap(`
            <h2>Your request has been closed</h2>
            <p><strong>${ticketNumber}</strong>: ${subject}</p>
            <p>This ticket has been resolved and has been closed.</p>
            <p>If this didn't actually fix things, just reply to this email (quoting the [${ticketNumber}] tag in the subject) and it'll reopen and come straight back to us.</p>
            ${linkLine(ticketId)}
        `);
        const text = [
            'Your request has been closed',
            `${ticketNumber}: ${subject}`,
            'This ticket has been resolved and has been closed.',
            "If this didn't actually fix things, just reply to this email and it'll reopen and come straight back to us.",
            appLink(ticketId),
        ].filter(Boolean).join('\n');
        return { subject: `Closed: [${ticketNumber}] ${subject}`, html, text };
    }, 'auto-closed', ticketId);
}

module.exports = {
    sendTicketCreatedEmail,
    sendNewReplyEmail,
    sendAssignedEmail,
    sendSLAWarningEmail,
    sendSLABreachedEmail,
    sendResolvedEmail,
    sendAutoClosedEmail,
};
