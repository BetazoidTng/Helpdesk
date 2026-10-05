// Minimal SMTP mailer using nodemailer. If SMTP isn't configured (no
// SMTP_HOST set in .env), sendMail() just logs and does nothing -- so
// ticket notification emails simply don't fire until SMTP is set up,
// without breaking anything else in the app.

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
    if (!process.env.SMTP_HOST) return null;
    if (!transporter) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true', // true for port 465, false for 587/STARTTLS
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
                : undefined,
        });
    }
    return transporter;
}

async function sendMail({ to, subject, html, text }) {
    if (!to) return; // nothing to send to (e.g. user has no email on file)
    const t = getTransporter();
    if (!t) {
        console.log('[mailer] SMTP not configured (SMTP_HOST unset) -- skipping email to %s: "%s"', to, subject);
        return;
    }
    await t.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to,
        subject,
        html,
        text,
    });
}

module.exports = { sendMail };
