(() => {
  const experienceByPath = {
    '/seller': 'seller',
    '/seller/mercado-livre': 'ml',
    '/seller/shopee': 'shopee',
    '/seller/rastreio': 'tracking',
    '/seller/tracking': 'tracking',
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
  if (!document.querySelector('script[src*="landing-experience.js"]')) {
    const script = document.createElement('script');
    script.src = '/brand/dachbyte/landing-experience.js?v=20260914';
    document.body.append(script);
  }
  const button = document.querySelector('[data-seller-menu]');
  const nav = document.querySelector('[data-seller-nav]');
  if (!button || !nav) return;
  const setOpen = (open) => {
    nav.classList.toggle('is-open', open);
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Fechar' : 'Menu';
  };
  button.addEventListener('click', () => setOpen(!nav.classList.contains('is-open')));
  nav.querySelectorAll('.seller-nav__links a').forEach((link) => {
    link.addEventListener('click', () => setOpen(false));
  });

  document.querySelectorAll('[data-seller-demo]').forEach((demo) => {
    const tabs = Array.from(demo.querySelectorAll('[data-seller-demo-tab]'));
    const panels = Array.from(demo.querySelectorAll('[data-seller-demo-panel]'));

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.getAttribute('data-seller-demo-tab');
        tabs.forEach((item) => item.setAttribute('aria-selected', String(item === tab)));
        panels.forEach((panel) => {
          panel.hidden = panel.getAttribute('data-seller-demo-panel') !== target;
        });
      });
    });
  });
})();
