(() => {
  const experienceByPath = {
    '/seller': 'seller',
    '/seller/mercado-livre': 'ml',
    '/seller/shopee': 'shopee',
    '/seller/rastreio': 'tracking',
    '/seller/tracking': 'tracking',
    '/seller/magalu': 'magalu',
  };
  const experience = experienceByPath[window.location.pathname.replace(/\/$/, '') || '/seller'];
  if (experience) {
    let host = document.querySelector('[data-dx-shell]');
    if (!host) {
      host = document.createElement('div');
      host.dataset.dxShell = 'seller';
      host.dataset.dxModule = experience === 'seller' ? 'Seller' : experience;
      document.body.prepend(host);
    }
    if (!document.querySelector('[data-dx-experience]')) {
      const section = document.createElement('section');
      section.dataset.dxExperience = experience;
      const hero = document.querySelector('.seller-hero');
      if (hero) hero.after(section);
    }
  }
  const initSellerDemos = () => document.querySelectorAll('[data-seller-demo]').forEach((demo) => {
    const tabs = Array.from(demo.querySelectorAll('[data-seller-demo-tab]'));
    const panels = Array.from(demo.querySelectorAll('[data-seller-demo-panel]'));
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-seller-demo-tab');
        tabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
        panels.forEach((panel) => { panel.hidden = panel.getAttribute('data-seller-demo-panel') !== target; });
      });
    });
  });

  initSellerDemos();

  const shopeeTrialLink = document.querySelector('[data-shopee-trial-start]');
  if (shopeeTrialLink && experience === 'shopee') {
    fetch('/shopee/auth/trial/availability', { credentials: 'same-origin', cache: 'no-store' })
      .then((response) => response.ok ? response.json() : { available: false })
      .then((state) => {
        if (state.available !== true) return;
        shopeeTrialLink.textContent = 'Testar grátis por 7 dias';
        shopeeTrialLink.addEventListener('click', async (event) => {
          event.preventDefault();
          if (shopeeTrialLink.dataset.loading === 'true') return;
          shopeeTrialLink.dataset.loading = 'true';
          shopeeTrialLink.textContent = 'Conectando à Shopee…';
          try {
            const response = await fetch('/shopee/auth/trial/start', {
              credentials: 'same-origin', cache: 'no-store',
            });
            const payload = response.ok ? await response.json() : null;
            if (!payload?.ok || !/^https:\/\//.test(payload.auth_url || '')) throw new Error('trial_start_unavailable');
            window.location.assign(payload.auth_url);
          } catch (_error) {
            shopeeTrialLink.textContent = 'Tentar conexão novamente';
            shopeeTrialLink.dataset.loading = 'false';
          }
        });
      })
      .catch(() => {});
  }
})();
