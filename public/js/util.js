// Small shared helpers used across pages.

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return d.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    return d.toLocaleString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function statusBadge(status) {
    return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function priorityBadge(priority) {
    return `<span class="badge priority-${escapeHtml(priority)}">${escapeHtml(priority)}</span>`;
}

function roleBadge(role) {
    return `<span class="badge role-${escapeHtml(role)}">${escapeHtml(role)}</span>`;
}

// Lets someone paste a screenshot (Ctrl+V, or Cmd+V on Mac) straight into a
// form that already has a <input type="file"> attachments field. A native
// file input's FileList can't be added to programmatically, so pasted
// images are tracked in a separate in-memory list -- each shown as a small
// removable thumbnail -- and merged into the form's FormData at submit time
// via appendTo(), under the same "attachments" field name the server
// already expects from the file picker. Caller is responsible for calling
// reset() after a successful submit (and ideally on form reset) to release
// the object URLs and clear the preview strip.
function setupPasteAttachments({ pasteTarget, fileInputId, previewId, maxFiles }) {
    const fileInput = document.getElementById(fileInputId);
    const preview = document.getElementById(previewId);
    let pasted = [];

    function totalCount() {
        return (fileInput && fileInput.files ? fileInput.files.length : 0) + pasted.length;
    }

    function renderPreview() {
        if (!preview) return;
        if (pasted.length === 0) {
            preview.innerHTML = '';
            preview.style.display = 'none';
            return;
        }
        preview.style.display = 'flex';
        preview.innerHTML = pasted.map((p, i) => `
            <span class="paste-thumb">
                <img src="${p.url}" alt="Pasted screenshot">
                <button type="button" class="paste-thumb-remove" data-remove="${i}" aria-label="Remove pasted screenshot">&times;</button>
            </span>
        `).join('');
        preview.querySelectorAll('[data-remove]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = Number(btn.dataset.remove);
                URL.revokeObjectURL(pasted[idx].url);
                pasted.splice(idx, 1);
                renderPreview();
            });
        });
    }

    pasteTarget.addEventListener('paste', (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        let added = 0;
        for (const item of items) {
            if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
            if (totalCount() >= (maxFiles || 5)) break;
            const file = item.getAsFile();
            if (!file) continue;
            const ext = (item.type.split('/')[1] || 'png').split(';')[0];
            const named = new File([file], `screenshot-${Date.now()}-${pasted.length + 1}.${ext}`, { type: item.type });
            pasted.push({ file: named, url: URL.createObjectURL(named) });
            added++;
        }
        if (added > 0) renderPreview();
    });

    return {
        appendTo(formData) {
            pasted.forEach((p) => formData.append('attachments', p.file, p.file.name));
        },
        count: totalCount,
        reset() {
            pasted.forEach((p) => URL.revokeObjectURL(p.url));
            pasted = [];
            renderPreview();
        },
    };
}

async function fetchJson(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
}
