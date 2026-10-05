// Writes one row to dbo.AuditLog. Called from every route that creates,
// updates, or deletes a Ticket/User/Category/KBArticle/Setting, so an
// Admin can see exactly who changed what and when (see routes/admin.js for
// how it's read back).
const { sql, getPool } = require('../db/pool');

async function logAudit(pool, { userId, action, entityType, entityId, summary, details }) {
    try {
        await pool.request()
            .input('userId', sql.Int, userId)
            .input('action', sql.NVarChar, action)
            .input('entityType', sql.NVarChar, entityType)
            .input('entityId', sql.Int, entityId)
            .input('summary', sql.NVarChar, summary || '')
            .input('details', sql.NVarChar, details ? JSON.stringify(details) : null)
            .query(`
                INSERT INTO dbo.AuditLog (UserId, Action, EntityType, EntityId, Summary, Details)
                VALUES (@userId, @action, @entityType, @entityId, @summary, @details)
            `);
    } catch (err) {
        // Never let an audit-log failure break the actual request -- the
        // real operation (the create/update/delete) has already succeeded
        // by the time this runs.
        console.error('Failed to write audit log entry:', err.message);
    }
}

module.exports = { logAudit, getPool, sql };
