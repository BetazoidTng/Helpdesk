// Lets this app serve HTTPS directly, at the same time as the plain HTTP
// listener in server/index.js -- both ports stay up together, so the site
// is reachable at either http://... or https://..., rather than needing a
// separate reverse proxy (IIS, nginx, etc) purely to add TLS in front of
// it. Configured via SSL_CERT_PATH / SSL_KEY_PATH (and optionally
// SSL_CA_PATH for an intermediate chain) in .env. If either path is unset,
// or the file it points to doesn't exist, HTTPS is simply skipped and the
// app carries on HTTP-only, exactly as it always has.
const fs = require('fs');
const https = require('https');

function startHttpsServer(app, { port, certPath, keyPath, caPath, onListening, onSkipped }) {
    if (!certPath || !keyPath) {
        if (onSkipped) onSkipped('SSL_CERT_PATH/SSL_KEY_PATH not set');
        return null;
    }
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        const missing = !fs.existsSync(certPath) ? certPath : keyPath;
        if (onSkipped) onSkipped(`file not found: ${missing}`);
        return null;
    }

    const options = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
    };
    if (caPath) {
        if (fs.existsSync(caPath)) {
            options.ca = fs.readFileSync(caPath);
        } else {
            console.error(`SSL_CA_PATH is set but doesn't exist -- starting HTTPS without the intermediate chain: ${caPath}`);
        }
    }

    const server = https.createServer(options, app);
    server.on('error', (err) => {
        console.error('HTTPS server failed to start:', err.message);
    });
    server.listen(port, () => {
        if (onListening) onListening(port);
    });
    return server;
}

module.exports = { startHttpsServer };
