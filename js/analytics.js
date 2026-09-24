/*
 * Visit counting with GoatCounter: no cookies, no identifier stored on the
 * device, aggregated data on European servers. Loaded by the plotter only,
 * not by the privacy and licence pages.
 *
 * GoatCounter counts the page path, never the part after #, so the formulas
 * people type are not sent anywhere.
 *
 * The address below is the only thing to change if the site code on
 * goatcounter.com ever changes.
 */
(function () {
  'use strict';
  var ENDPOINT = 'https://lirux.goatcounter.com/count';

  window.goatcounter = { endpoint: ENDPOINT };

  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.setAttribute('data-goatcounter', ENDPOINT);
  document.head.appendChild(s);
})();
