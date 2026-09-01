// Google Analytics (GA4) — single source of truth.
//
// Replace the placeholder below with your real Measurement ID (starts with
// "G-") from analytics.google.com — Admin → Data Streams → your web stream.
// Every page on the site loads this one file, so you only ever update the
// ID here instead of hunting through every HTML file.
//
// Until you set a real ID, this intentionally does nothing (no network
// request, no tracking) — analytics.js checks for the placeholder below and
// skips loading GA entirely rather than sending garbage data to a fake ID.

const GA_MEASUREMENT_ID = 'G-XXXXXXXXXX'; // <-- replace with your real ID

(function () {
  if (!GA_MEASUREMENT_ID || GA_MEASUREMENT_ID === 'G-XXXXXXXXXX') {
    console.log('[analytics] No real GA_MEASUREMENT_ID set in js/analytics.js — skipping analytics load.');
    return;
  }

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);
})();
