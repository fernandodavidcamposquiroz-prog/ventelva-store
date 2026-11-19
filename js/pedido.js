const controlMenu = document.querySelector('.menu-control');
const navegacion = document.querySelector('#navegacion');
const pantallaMovil = matchMedia('(max-width: 700px)');

function cerrarMenu() {
  controlMenu.setAttribute('aria-expanded', 'false');
}

controlMenu.hidden = false;
controlMenu.addEventListener('click', () => {
  controlMenu.setAttribute('aria-expanded', String(controlMenu.getAttribute('aria-expanded') === 'false'));
});
navegacion.addEventListener('click', cerrarMenu);
document.addEventListener('click', evento => {
  if (!navegacion.contains(evento.target) && !controlMenu.contains(evento.target)) cerrarMenu();
});
document.addEventListener('keydown', evento => {
  if (evento.key === 'Escape' && controlMenu.getAttribute('aria-expanded') === 'true') {
    cerrarMenu();
    controlMenu.focus();
  }
});
document.addEventListener('focusin', evento => {
  if (evento.target !== controlMenu && !navegacion.contains(evento.target)) cerrarMenu();
});
pantallaMovil.addEventListener('change', cerrarMenu);
