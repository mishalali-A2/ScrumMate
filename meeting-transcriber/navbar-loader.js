/**
 * navbar-loader.js
 * Fetches navbar.html, injects it into <aside id="sidebar">,
 * marks the active item via <body data-nav="…">, and wires the toggle.
 *
 * Usage in each page:
 *   <aside class="sidebar" id="sidebar"></aside>
 *   <body data-nav="dashboard">   ← one of: start | dashboard | projects | meetings | analytics | session
 *   <script src="navbar-loader.js"></script>
 */
(async function () {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;

    try {
        const res  = await fetch('navbar.html');
        const html = await res.text();
        sidebar.innerHTML = html;
    } catch (e) {
        console.warn('navbar-loader: could not load navbar.html', e);
        return;
    }

    // Mark active nav item
    const activeKey = document.body.dataset.nav || '';
    if (activeKey) {
        const target = sidebar.querySelector(`[data-nav="${activeKey}"]`);
        if (target) target.classList.add('active');
    }

    // Sidebar collapse toggle
    const toggleBtn = document.getElementById('sidebarToggle');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => sidebar.classList.toggle('collapsed'));
    }

    // Topbar date
    const metaEl = document.getElementById('topbarMeta');
    if (metaEl) {
        metaEl.textContent = new Date().toLocaleDateString('en-US', {
            weekday: 'long', month: 'short', day: 'numeric'
        });
    }
})();
