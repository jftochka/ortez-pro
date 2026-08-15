(function () {
  var modal = document.getElementById('lightbox-modal');
  var img = document.getElementById('lightbox-img');
  var closeBtn = document.getElementById('lightbox-close');
  var prevBtn = document.getElementById('lightbox-prev');
  var nextBtn = document.getElementById('lightbox-next');
  var currentItems = [];
  var currentIndex = 0;

  function isAllowedSrc(src) {
    return !!src && src.indexOf('/images/') === 0 && src.indexOf('..') === -1;
  }

  function collectItems() {
    currentItems = Array.prototype.slice.call(
      document.querySelectorAll('[data-lightbox-src]')
    ).filter(function (el) {
      return isAllowedSrc(el.getAttribute('data-lightbox-src'));
    });
  }

  function showAt(index) {
    if (index < 0 || index >= currentItems.length) return;
    var src = currentItems[index].getAttribute('data-lightbox-src');
    if (!isAllowedSrc(src)) return;
    currentIndex = index;
    img.src = src;
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';
    prevBtn.style.display = currentIndex > 0 ? '' : 'none';
    nextBtn.style.display = currentIndex < currentItems.length - 1 ? '' : 'none';
  }

  function closeLightbox() {
    modal.classList.remove('active');
    document.body.style.overflow = '';
    img.src = '';
  }

  document.addEventListener('click', function (e) {
    var item = e.target.closest('[data-lightbox-src]');
    if (!item) return;
    e.preventDefault();
    collectItems();
    var idx = currentItems.indexOf(item);
    if (idx !== -1) showAt(idx);
  });

  if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
  if (prevBtn) prevBtn.addEventListener('click', function () { showAt(currentIndex - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { showAt(currentIndex + 1); });

  if (modal) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeLightbox();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (!modal || !modal.classList.contains('active')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') showAt(currentIndex - 1);
    if (e.key === 'ArrowRight') showAt(currentIndex + 1);
  });

  var touchStartX = 0;
  if (modal) {
    modal.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });
    modal.addEventListener('touchend', function (e) {
      var diff = e.changedTouches[0].screenX - touchStartX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) showAt(currentIndex - 1);
        else showAt(currentIndex + 1);
      }
    }, { passive: true });
  }
})();
