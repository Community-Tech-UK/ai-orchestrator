'use strict';
const { createHash } = require('node:crypto');

// Visually reviewed, metadata-free PDF skill icon. A changed asset needs review;
// extensions alone never authorize binary setup content.
const REVIEWED_ASSETS = new Map([['.codex/skills/pdf/assets/pdf.png', {
  bytes: 1312, sha256: '17da356d195d4e3fa24f9becbee6b8d9e60e13005762b5ab0809c520c76da6ee',
}]]);
const isReviewedAsset = relative => REVIEWED_ASSETS.has(relative);
function validateAsset(asset) {
  const fail = () => { throw new Error('Unrecognized or changed reviewed asset; separate review required'); };
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)
    || Object.keys(asset).length !== 2 || !Object.hasOwn(asset, 'path') || !Object.hasOwn(asset, 'base64')) fail();
  const expected = REVIEWED_ASSETS.get(asset.path);
  if (!expected || typeof asset.base64 !== 'string' || asset.base64.length !== Math.ceil(expected.bytes / 3) * 4) fail();
  const bytes = Buffer.from(asset.base64, 'base64');
  if (bytes.length !== expected.bytes || bytes.toString('base64') !== asset.base64
    || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) fail();
  return bytes;
}
module.exports = { isReviewedAsset, validateAsset };
