const express = require('express');
const { hashPassword, verifyPassword } = require('../lib/password');
const { getIdleTimeoutMinutes } = require('../lib/idleTimeout');
const { lookupGeo } = require('../lib/geoLookup');
const { isSelfRegistrationEnabled } = require('../lib/settings');
const { sql, getPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Best-effort real client IP -- trusts X-Forwarded-For only when
// NODE_ENV=production has told Express to trust the proxy (see
// server/index.js's `app.set('trust proxy', 1)`), otherwise req.ip is the
// direct socket address, which is what you want for local/LAN testing.
function getClientIp(req) {
    return (req.ip || req.connection.remoteAddress || '').replace('::ffff:', '');
}

async function startSession(req, pool, user) {
    const ip = getClientIp(req);
    const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
    const geo = await lookupGeo(ip);

    const sessionInsert = await pool.request()
        .input('userId', sql.Int, user.Id)
        .input('ip', sql.NVarChar, ip)
        .input('userAgent', sql.NVarChar, userAgent)
        .input('city', sql.NVarChar, geo.city)
        .input('country', sql.NVarChar, geo.country)
        .query(`
            INSERT INTO dbo.LoginSessions (UserId, IpAddress, UserAgent, City, Country)
            OUTPUT INSERTED.Id
            VALUES (@userId, @ip, @userAgent, @city, @country)
        `);

    req.session.user = {
        id: user.Id,
        username: user.Username,
        fullName: user.FullName,
        email: user.Email,
        role: user.Role,
        requesterType: user.RequesterType || null,
    };
    req.session.sessionRowId = sessionInsert.recordset[0].Id;
    req.session.lastSeen = Date.now();
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const pool = await getPool();
        const result = await pool.request()
            .input('username', sql.NVarChar, username)
            .query('SELECT Id, Username, Email, PasswordHash, FullName, Role, RequesterType, IsActive FROM dbo.Users WHERE Username = @username');

        const user = result.recordset[0];
        if (!user || !user.IsActive) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const match = verifyPassword(password, user.PasswordHash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        await startSession(req, pool, user);
        res.json({ user: req.session.user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed.' });
    }
});

// POST /api/auth/register -- self-service signup for a Requester account
// (internal staff or an external customer -- see RequesterType). Admins
// and Agents are never created this way; only an existing Admin can make
// those, from Admin -> Users. Gated by the Admin -> Settings
// "Allow self-registration" toggle.
router.post('/register', async (req, res) => {
    try {
        const pool = await getPool();
        if (!(await isSelfRegistrationEnabled(pool))) {
            return res.status(403).json({ error: 'Self-registration is currently turned off -- ask an Admin to create your account.' });
        }

        const { username, email, password, fullName, requesterType } = req.body;
        if (!username || !email || !password || !fullName) {
            return res.status(400).json({ error: 'Full name, username, email and password are all required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        const type = requesterType === 'Internal' ? 'Internal' : 'External';

        const existing = await pool.request()
            .input('username', sql.NVarChar, username)
            .input('email', sql.NVarChar, email)
            .query('SELECT Id FROM dbo.Users WHERE Username = @username OR Email = @email');
        if (existing.recordset.length > 0) {
            return res.status(409).json({ error: 'That username or email is already registered.' });
        }

        const passwordHash = hashPassword(password);
        const insertResult = await pool.request()
            .input('username', sql.NVarChar, username)
            .input('email', sql.NVarChar, email)
            .input('passwordHash', sql.NVarChar, passwordHash)
            .input('fullName', sql.NVarChar, fullName)
            .input('requesterType', sql.NVarChar, type)
            .query(`
                INSERT INTO dbo.Users (Username, Email, PasswordHash, FullName, Role, RequesterType)
                OUTPUT INSERTED.Id, INSERTED.Username, INSERTED.Email, INSERTED.FullName, INSERTED.Role, INSERTED.RequesterType
                VALUES (@username, @email, @passwordHash, @fullName, 'Requester', @requesterType)
            `);

        const user = insertResult.recordset[0];
        await startSession(req, pool, { ...user, IsActive: true });
        res.status(201).json({ user: req.session.user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed.' });
    }
});

// POST /api/auth/logout
router.post('/logout', requireAuth, async (req, res) => {
    const sessionRowId = req.session.sessionRowId;
    req.session = null;

    if (sessionRowId) {
        try {
            const pool = await getPool();
            await pool.request()
                .input('id', sql.Int, sessionRowId)
                .query(`
                    UPDATE dbo.LoginSessions
                    SET LogoutAt = SYSUTCDATETIME(), EndReason = 'Logout'
                    WHERE Id = @id AND LogoutAt IS NULL
                `);
        } catch (err) {
            console.error('Failed to close session row on logout:', err.message);
        }
    }

    res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', (req, res) => {
    const user = (req.session && req.session.user) || null;
    res.json({
        user,
        idleTimeoutMinutes: getIdleTimeoutMinutes(user && user.role),
    });
});

module.exports = router;
