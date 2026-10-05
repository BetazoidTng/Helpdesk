// Shared SQL Server connection pool (using the `mssql` package).
// Every route reuses this single pool rather than opening new connections.

const sql = require('mssql');
require('dotenv').config();

const config = {
    server: process.env.DB_SERVER || 'localhost',
    port: parseInt(process.env.DB_PORT || '1435', 10),
    database: process.env.DB_NAME || 'Helpdesk',
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || 'Helpdesk!2024',
    options: {
        // Local Docker SQL Server / an on-prem SQL Server don't need TLS by
        // default; a cloud-hosted SQL Server (e.g. Azure SQL Database)
        // requires it. Set DB_ENCRYPT=true in .env for those.
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: process.env.DB_ENCRYPT !== 'true',
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
    },
};

let poolPromise;

function getPool() {
    if (!poolPromise) {
        poolPromise = new sql.ConnectionPool(config)
            .connect()
            .then((pool) => {
                console.log('Connected to SQL Server at %s:%s', config.server, config.port);
                return pool;
            })
            .catch((err) => {
                poolPromise = null; // allow retry on next call
                console.error('SQL Server connection failed:', err.message);
                throw err;
            });
    }
    return poolPromise;
}

module.exports = { sql, getPool };
