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

const CLERK_PK  = 'pk_test_cmVzb2x2ZWQtd2FscnVzLTg4LmNsZXJrLmFjY291bnRzLmRldiQ';
const CLERK_SRC = 'https://cdn.jsdelivr.net/npm/@clerk/clerk-js@4/dist/clerk.browser.js';

/** Ensures Clerk is loaded and initialised, resolves with the Clerk instance. */
function ensureClerk() {
    return new Promise((resolve) => {
        function init() {
            window.Clerk.load().then(() => resolve(window.Clerk)).catch(() => resolve(null));
        }
        if (window.Clerk) { init(); return; }
        const s = document.createElement('script');
        s.src = CLERK_SRC;
        s.async = true;
        s.crossOrigin = 'anonymous';
        s.setAttribute('data-clerk-publishable-key', CLERK_PK);
        s.onload = init;
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
    });
}

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

    // ── Profile card: chevron button toggles the sign-out dropdown ──
    const profileChevronBtn = document.getElementById('profileChevronBtn');
    const profileMenu       = document.getElementById('profileMenu');
    const signOutBtn        = document.getElementById('signOutBtn');

    if (profileChevronBtn && profileMenu) {
        profileChevronBtn.addEventListener('click', e => {
            e.stopPropagation();
            const isOpen = profileMenu.classList.contains('open');
            profileMenu.classList.toggle('open', !isOpen);
            profileChevronBtn.setAttribute('aria-expanded', String(!isOpen));
        });

        document.addEventListener('click', e => {
            const wrap = document.getElementById('profileWrap');
            if (wrap && !wrap.contains(e.target)) {
                profileMenu.classList.remove('open');
                profileChevronBtn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    // Sign out — ensures Clerk is loaded before calling signOut()
    if (signOutBtn) {
        signOutBtn.addEventListener('click', async () => {
            signOutBtn.textContent = 'Signing out…';
            signOutBtn.disabled = true;
            try {
                const clerk = await ensureClerk();
                if (clerk) await clerk.signOut();
            } catch (_) {}
            window.location.replace('login.html');
        });
    }

    // Populate name/initials/role and optional profile photo
    function applyProfile(name, role, photoUrl) {
        if (!name) return;
        const nameEl = document.getElementById('profileName');
        if (nameEl) nameEl.textContent = name;

        const roleEl = document.getElementById('profileRole');
        if (roleEl) roleEl.textContent = role || 'Team member';

        const avatarEl = document.getElementById('profileAvatar');
        if (avatarEl) {
            if (photoUrl) {
                // Show photo — replace any existing img or text
                avatarEl.textContent = '';
                let img = avatarEl.querySelector('img.avatar-photo');
                if (!img) {
                    img = document.createElement('img');
                    img.className = 'avatar-photo';
                    img.alt = name;
                    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
                    avatarEl.appendChild(img);
                }
                img.src = photoUrl;
            } else {
                // Remove any stale photo and show initials
                const img = avatarEl.querySelector('img.avatar-photo');
                if (img) img.remove();
                const parts = name.trim().split(/\s+/);
                avatarEl.textContent = parts.length >= 2
                    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
                    : name.slice(0, 2).toUpperCase();
            }
        }
    }

    ensureClerk().then(async clerk => {
        if (!clerk?.session?.user) return;
        const user     = clerk.session.user;
        const email    = user.primaryEmailAddress?.emailAddress || user.emailAddresses?.[0]?.emailAddress || '';
        const photoUrl = user.imageUrl || user.profileImageUrl || null;

        // Optimistically show Clerk name + photo while DB call is in flight
        applyProfile(user.fullName || user.firstName || '', null, photoUrl);

        // Pull real name + role from the profile table
        if (email) {
            try {
                const r    = await fetch(`/api/profiles/lookup?email=${encodeURIComponent(email)}`);
                const data = await r.json();
                if (data.success && data.profile) {
                    applyProfile(data.profile.name, data.profile.role, photoUrl);
                    sessionStorage.setItem('userEmail',    email);
                    sessionStorage.setItem('userFullName', data.profile.name);
                    sessionStorage.setItem('userRole',     data.profile.role || '');
                }
            } catch (_) { /* non-fatal — Clerk name already showing */ }
        }
    });
})();
