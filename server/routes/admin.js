// Admin-only management: users, categories, SLA policies, app settings,
// and a read-only view of the audit log and recent login sessions.
const express = require('express');
const { sql, getPool } = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { hashPassword } = require('../lib/password');
const { logAudit } = require('../lib/audit');
const { getSetting, setSetting } = require('../lib/settings');

const router = express.Router();
router.use(requireAdmin);

const ROLES = ['Admin', 'Agent', 'Requester'];

// ---- Users ---------------------------------------------------------------

router.get('/users', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT Id, Username, Email, FullName, Role, RequesterType, IsActive, CreatedAt
            FROM dbo.Users ORDER BY FullName ASC
        `);
        res.json({ users: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

router.post('/users', async (req, res) => {
    try {
        const { username, email, password, fullName, role, requesterType } = req.body;
        if (!username || !email || !password || !fullName) {
            return res.status(400).json({ error: 'Full name, username, email and password are all required.' });
        }
        if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        if (!ROLES.includes(role)) return res.status(400).json({ error: 'Role must be Admin, Agent, or Requester.' });

        const pool = await getPool();
        const existing = await pool.request()
            .input('username', sql.NVarChar, username)
            .input('email', sql.NVarChar, email)
            .query('SELECT Id FROM dbo.Users WHERE Username = @username OR Email = @email');
        if (existing.recordset.length > 0) {
            return res.status(409).json({ error: 'That username or email is already registered.' });
        }

        const type = role === 'Requester' ? (requesterType === 'Internal' ? 'Internal' : 'External') : null;
        const passwordHash = hashPassword(password);
        const insertResult = await pool.request()
            .input('username', sql.NVarChar, username)
            .input('email', sql.NVarChar, email)
            .input('passwordHash', sql.NVarChar, passwordHash)
            .input('fullName', sql.NVarChar, fullName)
            .input('role', sql.NVarChar, role)
            .input('requesterType', sql.NVarChar, type)
            .query(`
                INSERT INTO dbo.Users (Username, Email, PasswordHash, FullName, Role, RequesterType)
                OUTPUT INSERTED.Id
                VALUES (@username, @email, @passwordHash, @fullName, @role, @requesterType)
            `);
        await logAudit(pool, {
            userId: req.session.user.id, action: 'Create', entityType: 'User',
            entityId: insertResult.recordset[0].Id, summary: `Created ${role} user "${username}"`,
        });
        res.status(201).json({ id: insertResult.recordset[0].Id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create user.' });
    }
});

router.put('/users/:id', async (req, res) => {
    try {
        const pool = await getPool();
        const id = parseInt(req.params.id, 10);
        const existingResult = await pool.request().input('id', sql.Int, id)
            .query('SELECT * FROM dbo.Users WHERE Id = @id');
        const existing = existingResult.recordset[0];
        if (!existing) return res.status(404).json({ error: 'User not found.' });

        const fullName = req.body.fullName || existing.FullName;
        const role = ROLES.includes(req.body.role) ? req.body.role : existing.Role;
        const requesterType = role === 'Requester'
            ? (req.body.requesterType === 'Internal' ? 'Internal' : (existing.RequesterType || 'External'))
            : null;
        const isActive = req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : existing.IsActive;

        if (existing.Role === 'Admin' && role !== 'Admin') {
            const otherAdmins = await pool.request().input('id', sql.Int, id)
                .query("SELECT COUNT(*) AS n FROM dbo.Users WHERE Role = 'Admin' AND Id <> @id AND IsActive = 1");
            if (otherAdmins.recordset[0].n === 0) {
                return res.status(409).json({ error: "This is the only active Admin -- promote someone else first." });
            }
        }

        await pool.request()
            .input('id', sql.Int, id)
            .input('fullName', sql.NVarChar, fullName)
            .input('role', sql.NVarChar, role)
            .input('requesterType', sql.NVarChar, requesterType)
            .input('isActive', sql.Bit, isActive)
            .query(`
                UPDATE dbo.Users SET FullName = @fullName, Role = @role,
                    RequesterType = @requesterType, IsActive = @isActive
                WHERE Id = @id
            `);

        if (req.body.password) {
            if (req.body.password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            await pool.request()
                .input('id', sql.Int, id)
                .input('passwordHash', sql.NVarChar, hashPassword(req.body.password))
                .query('UPDATE dbo.Users SET PasswordHash = @passwordHash WHERE Id = @id');
        }

        await logAudit(pool, {
            userId: req.session.user.id, action: 'Update', entityType: 'User',
            entityId: id, summary: `Updated user "${existing.Username}"`,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update user.' });
    }
});

// ---- Categories -----------------------------------------------------------

router.get('/categories', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query('SELECT * FROM dbo.Categories ORDER BY Name ASC');
        res.json({ categories: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load categories.' });
    }
});

router.post('/categories', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'A name is required.' });
        const pool = await getPool();
        const result = await pool.request().input('name', sql.NVarChar, name)
            .query('INSERT INTO dbo.Categories (Name) OUTPUT INSERTED.Id VALUES (@name)');
        res.status(201).json({ id: result.recordset[0].Id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create category (it may already exist).' });
    }
});

router.put('/categories/:id', async (req, res) => {
    try {
        const pool = await getPool();
        const id = parseInt(req.params.id, 10);
        await pool.request()
            .input('id', sql.Int, id)
            .input('name', sql.NVarChar, req.body.name)
            .input('isActive', sql.Bit, req.body.isActive !== undefined ? (req.body.isActive ? 1 : 0) : 1)
            .query('UPDATE dbo.Categories SET Name = COALESCE(@name, Name), IsActive = @isActive WHERE Id = @id');
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update category.' });
    }
});

// ---- SLA policies -----------------------------------------------------------

router.get('/sla-policies', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query('SELECT * FROM dbo.SLAPolicies');
        res.json({ policies: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load SLA policies.' });
    }
});

router.put('/sla-policies/:priority', async (req, res) => {
    try {
        const { priority } = req.params;
        if (!['Low', 'Medium', 'High', 'Urgent'].includes(priority)) {
            return res.status(400).json({ error: 'Unknown priority.' });
        }
        const responseHours = parseFloat(req.body.responseHours);
        const resolutionHours = parseFloat(req.body.resolutionHours);
        if (!Number.isFinite(responseHours) || !Number.isFinite(resolutionHours) || responseHours <= 0 || resolutionHours <= 0) {
            return res.status(400).json({ error: 'Response and resolution hours must both be positive numbers.' });
        }
        const pool = await getPool();
        await pool.request()
            .input('priority', sql.NVarChar, priority)
            .input('responseHours', sql.Int, Math.round(responseHours))
            .input('resolutionHours', sql.Int, Math.round(resolutionHours))
            .query(`
                UPDATE dbo.SLAPolicies SET ResponseHours = @responseHours, ResolutionHours = @resolutionHours,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE Priority = @priority
            `);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update SLA policy.' });
    }
});

// ---- Settings -----------------------------------------------------------

router.get('/settings', async (req, res) => {
    try {
        const pool = await getPool();
        res.json({
            selfRegistrationEnabled: (await getSetting(pool, 'SelfRegistrationEnabled', 'true')) === 'true',
            slaWarningHoursBefore: Number(await getSetting(pool, 'SLAWarningHoursBefore', '1')),
            autoCloseResolvedEnabled: (await getSetting(pool, 'AutoCloseResolvedEnabled', 'true')) === 'true',
            autoCloseResolvedHours: Number(await getSetting(pool, 'AutoCloseResolvedHours', '1')),
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load settings.' });
    }
});

router.put('/settings', async (req, res) => {
    try {
        const pool = await getPool();
        if (req.body.selfRegistrationEnabled !== undefined) {
            await setSetting(pool, 'SelfRegistrationEnabled', req.body.selfRegistrationEnabled ? 'true' : 'false');
        }
        if (req.body.slaWarningHoursBefore !== undefined) {
            const hours = Number(req.body.slaWarningHoursBefore);
            if (!Number.isFinite(hours) || hours < 0) {
                return res.status(400).json({ error: 'SLA warning lead time must be a non-negative number.' });
            }
            await setSetting(pool, 'SLAWarningHoursBefore', String(hours));
        }
        if (req.body.autoCloseResolvedEnabled !== undefined) {
            await setSetting(pool, 'AutoCloseResolvedEnabled', req.body.autoCloseResolvedEnabled ? 'true' : 'false');
        }
        if (req.body.autoCloseResolvedHours !== undefined) {
            const hours = Number(req.body.autoCloseResolvedHours);
            if (!Number.isFinite(hours) || hours <= 0) {
                return res.status(400).json({ error: 'Auto-close lead time must be a positive number of hours.' });
            }
            await setSetting(pool, 'AutoCloseResolvedHours', String(hours));
        }
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update settings.' });
    }
});

// ---- Audit log & sessions (read-only) ---------------------------------------

router.get('/audit-log', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT TOP 200 a.Id, a.Action, a.EntityType, a.EntityId, a.Summary, a.CreatedAt, u.FullName AS UserName
            FROM dbo.AuditLog a
            LEFT JOIN dbo.Users u ON u.Id = a.UserId
            ORDER BY a.CreatedAt DESC
        `);
        res.json({ entries: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load audit log.' });
    }
});

router.get('/login-sessions', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT TOP 200 s.Id, s.LoginAt, s.LogoutAt, s.LastSeenAt, s.EndReason,
                   s.IpAddress, s.City, s.Country, u.FullName AS UserName, u.Role
            FROM dbo.LoginSessions s
            LEFT JOIN dbo.Users u ON u.Id = s.UserId
            ORDER BY s.LoginAt DESC
        `);
        res.json({ sessions: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load login sessions.' });
    }
});

module.exports = router;
