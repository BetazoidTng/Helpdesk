// Reporting/dashboard data for public/reports.html's Chart.js graphs --
// the user's own added requirement ("must be able to pull a report and
// view in graphical format"). Staff-only; each endpoint returns plain
// aggregates, no chart-specific shaping, so the frontend decides how to
// draw them.
const express = require('express');
const { sql, getPool } = require('../db/pool');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
router.use(requireStaff);

// GET /api/reports/summary -- headline numbers for the top of the page.
router.get('/summary', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT
                (SELECT COUNT(*) FROM dbo.Tickets WHERE Status IN ('New','Open','Pending')) AS OpenCount,
                (SELECT COUNT(*) FROM dbo.Tickets WHERE Status = 'Resolved' AND ResolvedAt >= DATEADD(DAY, -7, SYSUTCDATETIME())) AS ResolvedThisWeek,
                (SELECT COUNT(*) FROM dbo.Tickets WHERE SLABreached = 1 AND Status IN ('New','Open','Pending')) AS CurrentlyBreached,
                (SELECT COUNT(*) FROM dbo.Tickets WHERE CreatedAt >= DATEADD(DAY, -7, SYSUTCDATETIME())) AS CreatedThisWeek,
                (SELECT AVG(CAST(DATEDIFF(MINUTE, CreatedAt, ResolvedAt) AS FLOAT)) FROM dbo.Tickets WHERE ResolvedAt IS NOT NULL AND ResolvedAt >= DATEADD(DAY, -30, SYSUTCDATETIME())) AS AvgResolutionMinutes30d
        `);
        const row = result.recordset[0];
        res.json({
            openCount: row.OpenCount,
            resolvedThisWeek: row.ResolvedThisWeek,
            currentlyBreached: row.CurrentlyBreached,
            createdThisWeek: row.CreatedThisWeek,
            avgResolutionHours30d: row.AvgResolutionMinutes30d ? Math.round((row.AvgResolutionMinutes30d / 60) * 10) / 10 : null,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load report summary.' });
    }
});

// GET /api/reports/by-status
router.get('/by-status', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT Status, COUNT(*) AS Count FROM dbo.Tickets GROUP BY Status
        `);
        res.json({ rows: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load status breakdown.' });
    }
});

// GET /api/reports/by-priority
router.get('/by-priority', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT Priority, COUNT(*) AS Count FROM dbo.Tickets GROUP BY Priority
        `);
        res.json({ rows: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load priority breakdown.' });
    }
});

// GET /api/reports/by-category
router.get('/by-category', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT COALESCE(c.Name, 'Uncategorized') AS CategoryName, COUNT(*) AS Count
            FROM dbo.Tickets t
            LEFT JOIN dbo.Categories c ON c.Id = t.CategoryId
            GROUP BY c.Name
            ORDER BY Count DESC
        `);
        res.json({ rows: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load category breakdown.' });
    }
});

// GET /api/reports/trend?days=30 -- tickets created vs. resolved per day.
router.get('/trend', async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 180);
        const pool = await getPool();
        const createdResult = await pool.request().input('days', sql.Int, days).query(`
            SELECT CAST(CreatedAt AS DATE) AS Day, COUNT(*) AS Count
            FROM dbo.Tickets
            WHERE CreatedAt >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            GROUP BY CAST(CreatedAt AS DATE)
        `);
        const resolvedResult = await pool.request().input('days', sql.Int, days).query(`
            SELECT CAST(ResolvedAt AS DATE) AS Day, COUNT(*) AS Count
            FROM dbo.Tickets
            WHERE ResolvedAt IS NOT NULL AND ResolvedAt >= DATEADD(DAY, -@days, SYSUTCDATETIME())
            GROUP BY CAST(ResolvedAt AS DATE)
        `);

        const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
        const createdByDay = {};
        createdResult.recordset.forEach((r) => { createdByDay[dayKey(r.Day)] = r.Count; });
        const resolvedByDay = {};
        resolvedResult.recordset.forEach((r) => { resolvedByDay[dayKey(r.Day)] = r.Count; });

        const labels = [];
        const created = [];
        const resolved = [];
        const today = new Date();
        for (let i = days - 1; i >= 0; i -= 1) {
            const d = new Date(today);
            d.setUTCDate(d.getUTCDate() - i);
            const key = d.toISOString().slice(0, 10);
            labels.push(key);
            created.push(createdByDay[key] || 0);
            resolved.push(resolvedByDay[key] || 0);
        }

        res.json({ labels, created, resolved });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load trend data.' });
    }
});

// GET /api/reports/agent-workload
router.get('/agent-workload', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT u.FullName AS AgentName,
                   SUM(CASE WHEN t.Status IN ('New','Open','Pending') THEN 1 ELSE 0 END) AS OpenCount,
                   SUM(CASE WHEN t.Status IN ('Resolved','Closed') THEN 1 ELSE 0 END) AS ClosedCount
            FROM dbo.Users u
            LEFT JOIN dbo.Tickets t ON t.AssignedAgentId = u.Id
            WHERE u.Role IN ('Admin', 'Agent') AND u.IsActive = 1
            GROUP BY u.FullName
            ORDER BY OpenCount DESC
        `);
        res.json({ rows: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load agent workload.' });
    }
});

module.exports = router;
