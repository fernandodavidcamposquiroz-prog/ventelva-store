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

const reloj = document.querySelector('.reloj');
const finDemo = Date.now() + 24 * 60 * 60 * 1000;

function actualizarReloj() {
  const segundos = Math.max(0, Math.ceil((finDemo - Date.now()) / 1000));
  const partes = [Math.floor(segundos / 3600), Math.floor(segundos / 60) % 60, segundos % 60];
  reloj.textContent = partes.map(valor => String(valor).padStart(2, '0')).join(':');
  if (segundos === 0) clearInterval(intervaloDemo);
}

const intervaloDemo = setInterval(actualizarReloj, 1000);
actualizarReloj();
reloj.hidden = false;
