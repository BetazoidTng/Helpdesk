const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');
require('dotenv').config();

const { getIdleTimeoutMinutes } = require('./lib/idleTimeout');
const { getPool, sql } = require('./db/pool');
const { startSlaTimer } = require('./lib/slaTimer');
const { startEmailInboundPolling } = require('./lib/emailInbound');
const { startHttpsServer } = require('./lib/httpsServer');
const { attachSignaling } = require('./lib/remoteAssistSignaling');

const setupRoutes = require('./routes/setup');
const authRoutes = require('./routes/auth');
const ticketRoutes = require('./routes/tickets');
const categoryRoutes = require('./routes/categories');
const kbRoutes = require('./routes/kb');
const adminRoutes = require('./routes/admin');
const reportRoutes = require('./routes/reports');
const remoteAssistRoutes = require('./routes/remoteAssist');

const app = express();
const PORT = process.env.PORT || 3200;
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
    app.set('trust proxy', 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(cookieSession({
    name: 'helpdeskSession',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    maxAge: 1000 * 60 * 60 * 12, // 12 hours absolute max
    httpOnly: true,
    // Only ever "secure" once this is actually served over HTTPS -- see
    // the CRM/Auction Site's server/index.js for the full story on why
    // tying this to NODE_ENV is dangerous once deployed over plain HTTP.
    secure: process.env.COOKIE_SECURE === 'true',
    sameSite: 'lax',
}));

// Idle-session timeout, enforced server-side on every request (any
// client-side timer is just what proactively logs someone out while a tab
// sits open -- this is the backstop for when that doesn't fire). Also
// closes out the matching dbo.LoginSessions row so the audit trail shows
// an accurate "Idle" end reason instead of the session trailing off with
// no logout ever recorded.
app.use(async (req, res, next) => {
    if (req.session && req.session.user) {
        const now = Date.now();
        const timeoutMs = getIdleTimeoutMinutes(req.session.user.role) * 60 * 1000;

        if (req.session.lastSeen && now - req.session.lastSeen > timeoutMs) {
            const sessionRowId = req.session.sessionRowId;
            req.session = null;
            if (sessionRowId) {
                try {
                    const pool = await getPool();
                    await pool.request()
                        .input('id', sql.Int, sessionRowId)
                        .query(`
                            UPDATE dbo.LoginSessions
                            SET LogoutAt = SYSUTCDATETIME(), EndReason = 'Idle'
                            WHERE Id = @id AND LogoutAt IS NULL
                        `);
                } catch (err) {
                    console.error('Failed to close idle session row:', err.message);
                }
            }
            return next();
        }

        req.session.lastSeen = now;

        // Update LastSeenAt in the DB at most once every 30s per session,
        // not on every single request, so the "currently online" view is
        // fresh to within half a minute without hammering the database.
        if (!req.session.lastSeenWriteAt || now - req.session.lastSeenWriteAt > 30000) {
            req.session.lastSeenWriteAt = now;
            if (req.session.sessionRowId) {
                getPool()
                    .then((pool) => pool.request()
                        .input('id', sql.Int, req.session.sessionRowId)
                        .query('UPDATE dbo.LoginSessions SET LastSeenAt = SYSUTCDATETIME() WHERE Id = @id'))
                    .catch((err) => console.error('Failed to update LastSeenAt:', err.message));
            }
        }
    }
    next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/setup', setupRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/kb', kbRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/remote-assist', remoteAssistRoutes);

app.use((req, res) => {
    res.status(404).json({ error: 'Not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
});

const httpServer = app.listen(PORT, () => {
    console.log(`Helpdesk running at http://localhost:${PORT}`);
});
// Remote Assist's WebSocket signaling rides on this same HTTP server (and
// the HTTPS one below, if it's running) rather than a separate port --
// see server/lib/remoteAssistSignaling.js.
attachSignaling(httpServer);

// Also serves HTTPS on HTTPS_PORT, side by side with the HTTP listener
// above, if SSL_CERT_PATH/SSL_KEY_PATH are set in .env -- see
// server/lib/httpsServer.js. Skipped silently (HTTP-only, as always) when
// they aren't configured, which is the default.
const httpsServer = startHttpsServer(app, {
    port: process.env.HTTPS_PORT || 3443,
    certPath: process.env.SSL_CERT_PATH,
    keyPath: process.env.SSL_KEY_PATH,
    caPath: process.env.SSL_CA_PATH,
    onListening: (port) => console.log(`Helpdesk also running at https://localhost:${port}`),
    onSkipped: (reason) => console.log(`HTTPS not started (${reason}) -- running on HTTP only.`),
});
attachSignaling(httpsServer);

// Periodically flags overdue tickets as SLA-breached and warns agents
// when a ticket's SLA is coming due -- see server/lib/slaTimer.js.
startSlaTimer();

// Polls the support mailbox for inbound email-to-ticket, if IMAP_HOST is
// configured -- see server/lib/emailInbound.js. A no-op otherwise.
startEmailInboundPolling();
