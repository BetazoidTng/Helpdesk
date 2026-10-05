// Shared nav bar + session handling, included on every page.

// Some mobile browsers don't send/store cookies on same-origin fetch()
// calls unless credentials are explicitly requested. Patching fetch here,
// once, makes every fetch() call on every page always send/accept the
// session cookie.
(function patchFetchForCookies() {
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        init = init || {};
        if (!('credentials' in init)) {
            init.credentials = 'same-origin';
        }
        return originalFetch(input, init);
    };
})();

const PUBLIC_PAGES = ['/login.html', '/register.html', '/setup.html', '/kb.html', '/kb-article.html'];

async function initNav() {
    const navLinks = document.getElementById('nav-links');
    if (!navLinks) return;

    const navToggle = document.getElementById('nav-toggle');
    if (navToggle) {
        navToggle.addEventListener('click', () => {
            const isOpen = navLinks.classList.toggle('open');
            navToggle.setAttribute('aria-expanded', String(isOpen));
        });
    }

    try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();

        if (data.user) {
            const user = data.user;
            const staff = user.role === 'Admin' || user.role === 'Agent';
            const path = window.location.pathname;
            const linkHtml = (href, label) =>
                `<a href="${href}" class="${path === href ? 'active' : ''}">${label}</a>`;

            navLinks.innerHTML = `
                ${staff ? linkHtml('/queue.html', 'Ticket Queue') : linkHtml('/portal.html', 'My Tickets')}
                ${linkHtml('/kb.html', 'Knowledge Base')}
                ${staff ? linkHtml('/reports.html', 'Reports') : ''}
                ${user.role === 'Admin' ? linkHtml('/admin.html', 'Admin') : ''}
                <span class="meta">Hi, ${escapeHtml(user.fullName || user.username)}</span>
                <a href="#" id="logout-link">Log out</a>
            `;
            document.getElementById('logout-link').addEventListener('click', async (e) => {
                e.preventDefault();
                await fetch('/api/auth/logout', { method: 'POST' });
                window.location.href = '/login.html';
            });

            navLinks.querySelectorAll('a').forEach((a) => {
                a.addEventListener('click', () => {
                    navLinks.classList.remove('open');
                    if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
                });
            });

            setupIdleLogout(data.idleTimeoutMinutes);
        } else {
            if (!PUBLIC_PAGES.includes(window.location.pathname)) {
                window.location.href = '/login.html';
                return;
            }
            navLinks.innerHTML = `
                <a href="/kb.html">Knowledge Base</a>
                <a href="/login.html">Log in</a>
            `;
            if (navToggle) navToggle.style.display = window.location.pathname === '/kb.html' ? 'inline-block' : 'none';
        }
    } catch (err) {
        console.error('Failed to load session', err);
    }
}

// Watches for real user activity and forces a logout + redirect once none
// has happened for idleTimeoutMinutes. Shared across tabs via localStorage.
function setupIdleLogout(idleTimeoutMinutes) {
    const STORAGE_KEY = 'helpdeskLastActivity';
    const timeoutMs = (idleTimeoutMinutes || 30) * 60 * 1000;
    const checkIntervalMs = 15 * 1000;
    let loggingOut = false;

    const recordActivity = () => {
        try {
            localStorage.setItem(STORAGE_KEY, String(Date.now()));
        } catch (err) {
            window.__lastActivityFallback = Date.now();
        }
    };
    recordActivity();

    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evt) => {
        window.addEventListener(evt, recordActivity, { passive: true });
    });

    const getLastActivity = () => {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) return Number(stored);
        } catch (err) {
            // ignore
        }
        return window.__lastActivityFallback || Date.now();
    };

    setInterval(async () => {
        if (loggingOut || Date.now() - getLastActivity() <= timeoutMs) return;
        loggingOut = true;
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch (err) {
            // fall through to redirect regardless
        }
        window.location.href = '/login.html?reason=idle';
    }, checkIntervalMs);
}

document.addEventListener('DOMContentLoaded', initNav);
