// CardBreakPro PWA — Service Worker registration + Install banner

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function() {});
  });
}

// Install prompt
(function() {
  const DISMISS_KEY = 'cbp_install_dismissed';
  if (localStorage.getItem(DISMISS_KEY)) return;

  // Only show on mobile
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (!isMobile) return;

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function(e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallBanner(true);
  });

  // iOS Safari — no beforeinstallprompt, show manual instructions
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const isStandalone = window.navigator.standalone;
  if (isIOS && !isStandalone) {
    setTimeout(function() { showInstallBanner(false); }, 2500);
  }

  function showInstallBanner(hasNativePrompt) {
    if (document.getElementById('cbpInstallBanner')) return;

    const banner = document.createElement('div');
    banner.id = 'cbpInstallBanner';
    banner.style.cssText = [
      'position:fixed',
      'bottom:calc(64px + env(safe-area-inset-bottom, 0px) + 8px)',
      'left:12px',
      'right:12px',
      'background:#13131e',
      'border:1px solid rgba(79,110,247,0.4)',
      'border-radius:14px',
      'padding:12px 14px',
      'display:flex',
      'align-items:center',
      'gap:12px',
      'z-index:8888',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
      'animation:slideUp 0.3s ease'
    ].join(';');

    const text = hasNativePrompt
      ? '<span style="font-size:0.85rem;font-weight:600;color:#e2e8f0;flex:1;">Add CardBreakPro to your home screen for the best experience</span>'
      : '<span style="font-size:0.82rem;font-weight:600;color:#e2e8f0;flex:1;">Tap <strong style="color:#4f6ef7;">Share</strong> → <strong style="color:#4f6ef7;">Add to Home Screen</strong> for the full app experience</span>';

    const installBtn = hasNativePrompt
      ? '<button onclick="cbpInstallApp()" style="background:#4f6ef7;color:#fff;border:none;border-radius:8px;padding:0.5rem 1rem;font-size:0.82rem;font-weight:700;cursor:pointer;white-space:nowrap;">Install</button>'
      : '';

    banner.innerHTML =
      '<span style="font-size:1.4rem;">📲</span>' +
      text +
      installBtn +
      '<button onclick="cbpDismissInstall()" style="background:none;border:none;color:#64748b;font-size:1.1rem;cursor:pointer;padding:0.2rem;line-height:1;flex-shrink:0;">✕</button>';

    document.body.appendChild(banner);
  }

  window.cbpInstallApp = function() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function() { deferredPrompt = null; });
    }
    cbpDismissInstall();
  };

  window.cbpDismissInstall = function() {
    localStorage.setItem(DISMISS_KEY, '1');
    const b = document.getElementById('cbpInstallBanner');
    if (b) b.remove();
  };
})();

// Offline/online banner
(function() {
  function updateOnlineStatus() {
    let bar = document.getElementById('cbpOfflineBar');
    if (!navigator.onLine) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'cbpOfflineBar';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#ef4444;color:#fff;text-align:center;font-size:0.82rem;font-weight:700;padding:6px 1rem;z-index:99999;';
        bar.textContent = '📡 You\'re offline — some features unavailable';
        document.body.prepend(bar);
      }
    } else {
      if (bar) bar.remove();
    }
  }
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();
})();
