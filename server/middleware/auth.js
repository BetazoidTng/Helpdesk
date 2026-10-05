// Route-protection middleware, shared by every API route file.
function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not logged in.' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not logged in.' });
    }
    if (req.session.user.role !== 'Admin') {
        return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
}

// True for an Admin or an Agent -- the "staff" tier that works tickets,
// sees internal notes, and can see every ticket (not just their own).
function isStaffUser(user) {
    return !!user && (user.role === 'Admin' || user.role === 'Agent');
}

function requireStaff(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'Not logged in.' });
    }
    if (!isStaffUser(req.session.user)) {
        return res.status(403).json({ error: 'Only an Admin or Agent can do that.' });
    }
    next();
}

module.exports = { requireAuth, requireAdmin, requireStaff, isStaffUser };
