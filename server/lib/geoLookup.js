// Best-effort IP -> city/country lookup for the admin activity log, using
// ipapi.co's free tier (no API key, ~1000 lookups/day). This is purely
// informational (e.g. "Cape Town, South Africa" next to a login) and the
// app works fine if it's ever unreachable or rate-limited -- it just shows
// no location for that entry.
//
// Results are cached in memory per IP for a day, both to stay well under
// the free-tier rate limit and because the same office/VPN IP will be seen
// over and over.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const cache = new Map(); // ip -> { result, fetchedAt }

function isPrivateIp(ip) {
    if (!ip) return true;
    const clean = ip.replace('::ffff:', '');
    if (clean === '::1' || clean === '127.0.0.1' || clean === 'localhost') return true;
    if (/^10\./.test(clean)) return true;
    if (/^192\.168\./.test(clean)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(clean)) return true;
    return false;
}

async function lookupGeo(ip) {
    if (process.env.GEO_LOOKUP_ENABLED === 'false') {
        return { city: null, country: null };
    }
    if (isPrivateIp(ip)) {
        // Staff on the office LAN/VPN will show up this way until the app
        // is reachable by its real public IP -- expected, not a bug.
        return { city: 'Local network', country: null };
    }

    const cached = cache.get(ip);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return cached.result;
    }

    try {
        const clean = ip.replace('::ffff:', '');
        const res = await fetch(`https://ipapi.co/${clean}/json/`, {
            signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) throw new Error(`geo lookup HTTP ${res.status}`);
        const data = await res.json();
        const result = {
            city: data.city || null,
            country: data.country_name || null,
        };
        cache.set(ip, { result, fetchedAt: Date.now() });
        return result;
    } catch (err) {
        console.error('Geo-IP lookup failed for %s:', ip, err.message);
        return { city: null, country: null };
    }
}

module.exports = { lookupGeo, isPrivateIp };
