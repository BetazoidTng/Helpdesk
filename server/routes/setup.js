// First-run setup: creates the first Admin account through the browser
// instead of the command line. Once at least one Admin exists, this route
// refuses to create another this way -- further Admins/Agents are created
// by an existing Admin from Admin -> Users. (Unlike the CRM, this app
// allows more than one Admin -- a support desk commonly has more than one
// person running it -- so this is a one-time bootstrap step, not a
// permanent single-admin rule.)
const express = require('express');
const { sql, getPool } = require('../db/pool');
const { hashPassword } = require('../lib/password');

const router = express.Router();

async function adminExists(pool) {
    const result = await pool.request().query("SELECT TOP 1 Id FROM dbo.Users WHERE Role = 'Admin'");
    return result.recordset.length > 0;
}

// GET /api/setup/status
router.get('/status', async (req, res) => {
    try {
        const pool = await getPool();
        res.json({ needsSetup: !(await adminExists(pool)) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to check setup status.' });
    }
});

// POST /api/setup -- creates the first Admin. Refuses if one already exists.
router.post('/', async (req, res) => {
    try {
        const { username, email, password, fullName } = req.body;
        if (!username || !email || !password || !fullName) {
            return res.status(400).json({ error: 'Full name, username, email and password are all required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const pool = await getPool();

        if (await adminExists(pool)) {
            return res.status(409).json({ error: 'Setup has already been completed. Ask an Admin for an account.' });
        }

        const existing = await pool.request()
            .input('username', sql.NVarChar, username)
            .input('email', sql.NVarChar, email)
            .query('SELECT Id FROM dbo.Users WHERE Username = @username OR Email = @email');
        if (existing.recordset.length > 0) {
            return res.status(409).json({ error: 'That username or email is already registered.' });
        }

        const passwordHash = hashPassword(password);
        await pool.request()
            .input('username', sql.NVarChar, username)
            .input('email', sql.NVarChar, email)
            .input('passwordHash', sql.NVarChar, passwordHash)
            .input('fullName', sql.NVarChar, fullName)
            .query(`
                INSERT INTO dbo.Users (Username, Email, PasswordHash, FullName, Role)
                VALUES (@username, @email, @passwordHash, @fullName, 'Admin')
            `);

        res.status(201).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to complete setup.' });
    }
});

module.exports = router;
