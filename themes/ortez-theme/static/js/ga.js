(function () {
  var el = document.querySelector('meta[name="google-analytics-id"]');
  var id = el && el.getAttribute('content');
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', id);
})();
