// Small key/value app settings, backed by dbo.Settings, that an Admin can
// change from the UI. A short in-memory cache avoids a database round trip
// on every single check made by the SLA sweep, refreshed whenever a value
// is written or goes stale.
const { sql } = require('../db/pool');

const cache = new Map(); // key -> { value, expiresAt }
const CACHE_TTL_MS = 30 * 1000;

async function getSetting(pool, key, defaultValue) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = await pool.request()
        .input('key', sql.NVarChar, key)
        .query('SELECT SettingValue FROM dbo.Settings WHERE SettingKey = @key');
    const value = result.recordset[0] ? result.recordset[0].SettingValue : defaultValue;
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
}

async function setSetting(pool, key, value) {
    await pool.request()
        .input('key', sql.NVarChar, key)
        .input('value', sql.NVarChar, String(value))
        .query(`
            MERGE dbo.Settings AS target
            USING (SELECT @key AS SettingKey) AS src
            ON target.SettingKey = src.SettingKey
            WHEN MATCHED THEN UPDATE SET SettingValue = @value, UpdatedAt = SYSUTCDATETIME()
            WHEN NOT MATCHED THEN INSERT (SettingKey, SettingValue) VALUES (@key, @value);
        `);
    cache.delete(key);
}

// How many hours before a ticket's SLA resolution timer runs out to send a
// heads-up warning email to the assigned agent. 0 turns the warning off
// entirely (the "SLA breached" email still fires).
async function getSLAWarningHours(pool) {
    const value = await getSetting(pool, 'SLAWarningHoursBefore', '1');
    const hours = Number(value);
    return Number.isFinite(hours) && hours >= 0 ? hours : 1;
}

async function isSelfRegistrationEnabled(pool) {
    const value = await getSetting(pool, 'SelfRegistrationEnabled', 'true');
    return value === 'true';
}

// Whether a Resolved ticket should auto-close itself (and email the
// requester saying so) after sitting untouched for getAutoCloseResolvedHours().
async function isAutoCloseResolvedEnabled(pool) {
    const value = await getSetting(pool, 'AutoCloseResolvedEnabled', 'true');
    return value === 'true';
}

async function getAutoCloseResolvedHours(pool) {
    const value = await getSetting(pool, 'AutoCloseResolvedHours', '1');
    const hours = Number(value);
    return Number.isFinite(hours) && hours > 0 ? hours : 1;
}

module.exports = {
    getSetting,
    setSetting,
    getSLAWarningHours,
    isSelfRegistrationEnabled,
    isAutoCloseResolvedEnabled,
    getAutoCloseResolvedHours,
};
