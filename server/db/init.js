// One-off script: creates the Helpdesk database and tables, or brings an
// existing database up to date with any new columns/tables.
// Run with: npm run init-db
// Safe to re-run at any time -- schema.sql only creates tables/columns
// that don't already exist.
//
// Cloud SQL Server note: a cloud-hosted database (e.g. Azure SQL Database)
// doesn't support CREATE DATABASE or USE <other-db> the way a local SQL
// Server does. Set DB_ENCRYPT=true in .env when pointing at one of these,
// and this script connects straight to DB_NAME and skips those statements
// automatically.

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
require('dotenv').config();

const isCloud = process.env.DB_ENCRYPT === 'true';
const dbName = process.env.DB_NAME || 'Helpdesk';

const connectionConfig = {
    server: process.env.DB_SERVER || 'localhost',
    port: parseInt(process.env.DB_PORT || '1435', 10),
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || 'Helpdesk!2024',
    database: isCloud ? dbName : 'master',
    options: {
        encrypt: isCloud,
        trustServerCertificate: !isCloud,
    },
};

function splitBatches(sqlText) {
    return sqlText
        .split(/^\s*GO\s*$/im)
        .map((batch) => batch.trim())
        .filter((batch) => batch.length > 0);
}

function isDbSwitchBatch(batch) {
    return /^\s*USE\s+\S+\s*;?\s*$/i.test(batch)
        || /CREATE\s+DATABASE/i.test(batch);
}

async function runSqlFile(pool, filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const batches = splitBatches(text);
    for (const batch of batches) {
        if (isCloud && isDbSwitchBatch(batch)) continue;
        try {
            await pool.request().query(batch);
        } catch (err) {
            console.error('\n--- SQL batch that failed ---');
            console.error(batch);
            console.error('--- Error ---');
            console.error(err.message);
            if (Array.isArray(err.precedingErrors) && err.precedingErrors.length > 0) {
                console.error('--- Preceding SQL Server errors (the real cause is usually here) ---');
                err.precedingErrors.forEach((e, i) => console.error(`  [${i + 1}] ${e.message}`));
            }
            console.error('');
            throw err;
        }
    }
}

async function main() {
    console.log(
        'Connecting to %s SQL Server at %s:%s (database: %s) ...',
        isCloud ? 'cloud' : 'local',
        connectionConfig.server,
        connectionConfig.port,
        connectionConfig.database
    );

    const pool = await new sql.ConnectionPool(connectionConfig).connect();

    try {
        console.log('Applying schema...');
        await runSqlFile(pool, path.join(__dirname, '..', '..', 'db', 'schema.sql'));

        console.log('Applying seed data (none, by default)...');
        await runSqlFile(pool, path.join(__dirname, '..', '..', 'db', 'seed.sql'));

        console.log('Database ready. Visit the site to create your first Admin account, or run node server/db/create-admin.js.');
    } finally {
        await pool.close();
    }
}

main().catch((err) => {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
});
