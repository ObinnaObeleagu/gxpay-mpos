/**
 * uiModal.js - tiny, dependency-free modal controller.
 * Used for the "Device settings" panel (connect/disconnect, terminal info,
 * EMV/firmware updates). No jQuery/Bootstrap JS needed for this - the rest
 * of the SDK wiring in Script.js is plain vanilla JS too.
 */
(function () {
  'use strict';

  function openModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('is-open');
    document.addEventListener('keydown', onKeydown);
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('is-open');
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      document.querySelectorAll('.gx-modal-backdrop.is-open').forEach((el) => el.classList.remove('is-open'));
    }
  }

  window.openModal = openModal;
  window.closeModal = closeModal;
})();
