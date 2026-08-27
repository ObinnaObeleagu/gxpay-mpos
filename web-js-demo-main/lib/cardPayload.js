'use strict';

const VALID_ENTRY_MODES = ['ICC', 'MCR', 'NFC_ONLINE'];

/**
 * Validates the device payload sent up from the CR100-SCRP after a card
 * read. We deliberately only ever accept a masked PAN plus already-encrypted
 * material (KSN + DUKPT/3DES ciphertext, or EMV TLV tags for chip) - never a
 * cleartext PAN, full track, or PIN. See README-PAYMENT-INTEGRATION.md,
 * "Security & PCI notes".
 */
function validateDevicePayload(device) {
  const errors = [];
  if (!device || typeof device !== 'object') {
    return ['device payload is required'];
  }
  if (!VALID_ENTRY_MODES.includes(device.entryMode)) {
    errors.push(`device.entryMode must be one of ${VALID_ENTRY_MODES.join(', ')}`);
  }
  if (device.entryMode === 'ICC') {
    // For chip transactions the PAN lives inside the EMV TLV data (tag 5A)
    // at this point in the flow - we deliberately don't parse it out
    // client-side (that would mean handling a cleartext PAN in the
    // browser). GxPay/the backend can extract it from emvTags if its API
    // requires an explicit PAN field - see services/gxpayClient.js.
    if (!device.emvTags) {
      errors.push('device.emvTags is required for chip (ICC) entries');
    }
  } else {
    if (!device.maskedPan || !/^\*{2,}\d{2,4}$|\d{4}$/.test(device.maskedPan.replace(/\s/g, ''))) {
      errors.push('device.maskedPan is required and must be masked (last 4 digits only)');
    }
    if (!device.encryptedTrack2) {
      errors.push('device.encryptedTrack2 is required for swipe/contactless entries');
    }
  }
  // Reject anything that looks like a cleartext PAN slipping through.
  const looksLikeClearPan = (val) => typeof val === 'string' && /\d{12,19}/.test(val.replace(/\D/g, '')) && val.replace(/\D/g, '').length >= 12;
  ['track1', 'track2', 'track3', 'pan', 'cardNumber'].forEach((field) => {
    if (looksLikeClearPan(device[field])) {
      errors.push(`device.${field} looks like a cleartext PAN/track and was rejected - send only masked/encrypted data`);
    }
  });
  return errors;
}

function maskAmountReceiptCard(maskedPan) {
  if (!maskedPan) return '**** **** **** ****';
  const digits = maskedPan.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `**** **** **** ${last4}`;
}

module.exports = { validateDevicePayload, maskAmountReceiptCard, VALID_ENTRY_MODES };
