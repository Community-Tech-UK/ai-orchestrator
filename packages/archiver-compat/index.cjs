"use strict";

const {
  JsonArchive,
  TarArchive,
  ZipArchive,
} = require("archiver-modern");

const formats = new Map([
  ["json", JsonArchive],
  ["tar", TarArchive],
  ["zip", ZipArchive],
]);

function create(format, options) {
  const Archive = formats.get(format);
  if (!Archive) {
    throw new Error(`create(${format}): format not registered`);
  }
  return new Archive(options);
}

create.create = create;
create.registerFormat = (format, Archive) => {
  formats.set(format, Archive);
};
create.isRegisteredFormat = (format) => formats.has(format);

module.exports = create;
