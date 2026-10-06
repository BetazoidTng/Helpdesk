// Read-only category list for dropdowns (ticket submission form, queue
// filters, KB filters) -- any logged-in user. Creating/renaming/deactivating
// categories is an Admin job, handled in routes/admin.js instead.
const express = require('express');
const { getPool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query('SELECT Id, Name FROM dbo.Categories WHERE IsActive = 1 ORDER BY Name ASC');
        res.json({ categories: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load categories.' });
    }
});

module.exports = router;
