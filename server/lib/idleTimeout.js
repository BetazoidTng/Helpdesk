// Shared by server/index.js (which enforces the timeout) and
// server/routes/auth.js (which tells the browser what the timeout is, so
// nav.js's client-side idle timer matches it).
//
// Admins get a shorter timeout than everyone else by default, since an
// Admin session left open can do more damage (viewing everyone's activity,
// creating/deactivating users, etc).
function getIdleTimeoutMinutes(role) {
    if (role === 'Admin') {
        return Number(process.env.ADMIN_IDLE_TIMEOUT_MINUTES) || 10;
    }
    return Number(process.env.IDLE_TIMEOUT_MINUTES) || 30;
}

module.exports = { getIdleTimeoutMinutes };
