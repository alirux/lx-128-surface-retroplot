// Legal and notes pages: ESC and the BACK key return to the previous page of
// this site through the browser history, so the plotter comes back as it was
// left. Opened directly, they go to the plotter instead.
(function () {
  'use strict';

  function back(e) {
    var ref = document.referrer;
    var fromHere = ref && ref.indexOf(location.origin) === 0 && history.length > 1;
    if (fromHere) {
      if (e) e.preventDefault();
      history.back();
    } else if (!e) {
      location.href = './';
    }
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') back();
  });
  var key = document.querySelector('.keys-back a.key');
  if (key) key.addEventListener('click', back);
})();
