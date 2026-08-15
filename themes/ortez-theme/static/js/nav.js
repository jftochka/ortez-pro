document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.querySelector('.mobile-menu-toggle');
  var nav = document.querySelector('.main-nav');
  var overlay = document.querySelector('.nav-overlay');
  var body = document.body;

  function closeMenu() {
    if (toggle) toggle.classList.remove('active');
    if (nav) nav.classList.remove('active');
    if (overlay) overlay.classList.remove('active');
    body.classList.remove('menu-open');
  }

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      if (nav.classList.contains('active')) {
        closeMenu();
      } else {
        toggle.classList.add('active');
        nav.classList.add('active');
        if (overlay) overlay.classList.add('active');
        body.classList.add('menu-open');
      }
    });
  }

  if (overlay) overlay.addEventListener('click', closeMenu);

  document.querySelectorAll('.nav-link').forEach(function (link) {
    link.addEventListener('click', function () {
      if (window.innerWidth <= 768) closeMenu();
    });
  });
});
