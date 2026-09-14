(() => {
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
