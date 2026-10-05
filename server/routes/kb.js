// Knowledge base / FAQ. Published articles are readable by anyone
// (including a visitor who isn't logged in yet -- that's the point of a
// self-service KB), draft articles are visible only to Staff, and only
// Staff can write or publish.
const express = require('express');
const { sql, getPool } = require('../db/pool');
const { requireStaff, isStaffUser } = require('../middleware/auth');
const { logAudit } = require('../lib/audit');

const router = express.Router();

function slugify(title) {
    return (title || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 250) || 'article';
}

async function uniqueSlug(pool, title, excludeId) {
    const base = slugify(title);
    let slug = base;
    let n = 1;
    while (true) {
        const request = pool.request().input('slug', sql.NVarChar, slug);
        let query = 'SELECT Id FROM dbo.KBArticles WHERE Slug = @slug';
        if (excludeId) {
            request.input('excludeId', sql.Int, excludeId);
            query += ' AND Id <> @excludeId';
        }
        const result = await request.query(query);
        if (result.recordset.length === 0) return slug;
        n += 1;
        slug = `${base}-${n}`;
    }
}

function currentUser(req) {
    return (req.session && req.session.user) || null;
}

// GET /api/kb -- list. Anyone sees published articles; Staff also see drafts.
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const staff = isStaffUser(currentUser(req));
        const request = pool.request();
        const where = [];
        if (!staff) where.push('a.IsPublished = 1');
        if (req.query.categoryId) {
            where.push('a.CategoryId = @categoryId');
            request.input('categoryId', sql.Int, parseInt(req.query.categoryId, 10));
        }
        if (req.query.search) {
            where.push('(a.Title LIKE @search OR a.Body LIKE @search)');
            request.input('search', sql.NVarChar, `%${req.query.search}%`);
        }
        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const result = await request.query(`
            SELECT a.Id, a.Title, a.Slug, a.CategoryId, c.Name AS CategoryName,
                   a.IsPublished, a.ViewCount, a.CreatedAt, a.UpdatedAt
            FROM dbo.KBArticles a
            LEFT JOIN dbo.Categories c ON c.Id = a.CategoryId
            ${whereClause}
            ORDER BY a.Title ASC
        `);
        res.json({ articles: result.recordset });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load knowledge base articles.' });
    }
});

// GET /api/kb/:slug -- single article by slug; counts a view.
router.get('/:slug', async (req, res) => {
    try {
        const pool = await getPool();
        const staff = isStaffUser(currentUser(req));
        const result = await pool.request().input('slug', sql.NVarChar, req.params.slug).query(`
            SELECT a.*, c.Name AS CategoryName, u.FullName AS AuthorName
            FROM dbo.KBArticles a
            LEFT JOIN dbo.Categories c ON c.Id = a.CategoryId
            LEFT JOIN dbo.Users u ON u.Id = a.AuthorId
            WHERE a.Slug = @slug
        `);
        const article = result.recordset[0];
        if (!article || (!article.IsPublished && !staff)) {
            return res.status(404).json({ error: 'Article not found.' });
        }
        pool.request().input('id', sql.Int, article.Id)
            .query('UPDATE dbo.KBArticles SET ViewCount = ViewCount + 1 WHERE Id = @id')
            .catch((err) => console.error('Failed to bump KB view count:', err.message));
        res.json({ article });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to load article.' });
    }
});

// POST /api/kb -- Staff-only create.
router.post('/', requireStaff, async (req, res) => {
    try {
        const { title, body, categoryId, isPublished } = req.body;
        if (!title || !body) return res.status(400).json({ error: 'Title and body are required.' });

        const pool = await getPool();
        const slug = await uniqueSlug(pool, title);
        const result = await pool.request()
            .input('title', sql.NVarChar, title)
            .input('slug', sql.NVarChar, slug)
            .input('body', sql.NVarChar, body)
            .input('categoryId', sql.Int, categoryId ? parseInt(categoryId, 10) : null)
            .input('isPublished', sql.Bit, isPublished ? 1 : 0)
            .input('authorId', sql.Int, req.session.user.id)
            .query(`
                INSERT INTO dbo.KBArticles (Title, Slug, Body, CategoryId, IsPublished, AuthorId)
                OUTPUT INSERTED.Id, INSERTED.Slug
                VALUES (@title, @slug, @body, @categoryId, @isPublished, @authorId)
            `);
        await logAudit(pool, {
            userId: req.session.user.id, action: 'Create', entityType: 'KBArticle',
            entityId: result.recordset[0].Id, summary: `Created KB article "${title}"`,
        });
        res.status(201).json(result.recordset[0]);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create article.' });
    }
});

// PUT /api/kb/:id -- Staff-only update.
router.put('/:id', requireStaff, async (req, res) => {
    try {
        const pool = await getPool();
        const id = parseInt(req.params.id, 10);
        const existingResult = await pool.request().input('id', sql.Int, id)
            .query('SELECT * FROM dbo.KBArticles WHERE Id = @id');
        const existing = existingResult.recordset[0];
        if (!existing) return res.status(404).json({ error: 'Article not found.' });

        const title = req.body.title || existing.Title;
        const slug = title !== existing.Title ? await uniqueSlug(pool, title, id) : existing.Slug;
        const body = req.body.body !== undefined ? req.body.body : existing.Body;
        const categoryId = req.body.categoryId !== undefined ? (req.body.categoryId ? parseInt(req.body.categoryId, 10) : null) : existing.CategoryId;
        const isPublished = req.body.isPublished !== undefined ? (req.body.isPublished ? 1 : 0) : existing.IsPublished;

        await pool.request()
            .input('id', sql.Int, id)
            .input('title', sql.NVarChar, title)
            .input('slug', sql.NVarChar, slug)
            .input('body', sql.NVarChar, body)
            .input('categoryId', sql.Int, categoryId)
            .input('isPublished', sql.Bit, isPublished)
            .query(`
                UPDATE dbo.KBArticles SET
                    Title = @title, Slug = @slug, Body = @body, CategoryId = @categoryId,
                    IsPublished = @isPublished, UpdatedAt = SYSUTCDATETIME()
                WHERE Id = @id
            `);
        await logAudit(pool, {
            userId: req.session.user.id, action: 'Update', entityType: 'KBArticle',
            entityId: id, summary: `Updated KB article "${title}"`,
        });
        res.json({ ok: true, slug });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update article.' });
    }
});

// DELETE /api/kb/:id -- Staff-only hard delete.
router.delete('/:id', requireStaff, async (req, res) => {
    try {
        const pool = await getPool();
        const id = parseInt(req.params.id, 10);
        await pool.request().input('id', sql.Int, id).query('DELETE FROM dbo.KBArticles WHERE Id = @id');
        await logAudit(pool, {
            userId: req.session.user.id, action: 'Delete', entityType: 'KBArticle',
            entityId: id, summary: `Deleted KB article #${id}`,
        });
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to delete article.' });
    }
});

module.exports = router;
