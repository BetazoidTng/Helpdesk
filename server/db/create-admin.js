// CLI fallback for creating a user directly in the database. The normal
// way to create the first Admin is the /setup.html page in the app (see
// server/routes/setup.js) -- use this script only if you're locked out of
// the app entirely (e.g. every Admin's password is lost) and need to
// create a login without going through the UI.
//
// Usage:
//   node server/db/create-admin.js <username> <email> <password> "<Full Name>" [Admin|Agent|Requester]
//
// Example:
//   node server/db/create-admin.js alex alex@example.com "Sup3rSecret!" "Alex Jordan" Admin

const { sql, getPool } = require('./pool');
const { hashPassword } = require('../lib/password');

async function main() {
    const [username, email, password, fullName, role = 'Admin'] = process.argv.slice(2);

    if (!username || !email || !password || !fullName) {
        console.error('Usage: node server/db/create-admin.js <username> <email> <password> "<Full Name>" [Admin|Agent|Requester]');
        process.exit(1);
    }
    if (password.length < 8) {
        console.error('Password must be at least 8 characters.');
        process.exit(1);
    }
    if (!['Admin', 'Agent', 'Requester'].includes(role)) {
        console.error('Role must be Admin, Agent, or Requester.');
        process.exit(1);
    }

    const pool = await getPool();

    const existing = await pool.request()
        .input('username', sql.NVarChar, username)
        .input('email', sql.NVarChar, email)
        .query('SELECT Id FROM dbo.Users WHERE Username = @username OR Email = @email');

    if (existing.recordset.length > 0) {
        console.error('A user with that username or email already exists.');
        process.exit(1);
    }

    const passwordHash = hashPassword(password);

    await pool.request()
        .input('username', sql.NVarChar, username)
        .input('email', sql.NVarChar, email)
        .input('passwordHash', sql.NVarChar, passwordHash)
        .input('fullName', sql.NVarChar, fullName)
        .input('role', sql.NVarChar, role)
        .query(`
            INSERT INTO dbo.Users (Username, Email, PasswordHash, FullName, Role)
            VALUES (@username, @email, @passwordHash, @fullName, @role)
        `);

    console.log(`Created ${role} user "${username}". You can now log in with it.`);
    process.exit(0);
}

main().catch((err) => {
    console.error('Failed to create user:', err.message);
    process.exit(1);
});
