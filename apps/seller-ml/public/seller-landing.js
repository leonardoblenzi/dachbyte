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
})();
