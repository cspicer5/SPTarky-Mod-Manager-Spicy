/**
 * Builds a minimal but genuine .NET assembly in memory, for tests.
 *
 * Prepatcher dependency checks read the AssemblyRef table out of real CLI metadata, so a test
 * needs a file that has one. Shipping third-party mod DLLs as fixtures is not an option, and
 * there is no compiler on a test machine to make our own — so this writes the bytes directly:
 * a PE32 image with one section holding a CLI header and an ECMA-335 metadata root, with the
 * Module, Assembly, AssemblyRef and ManifestResource tables populated.
 *
 * It is intentionally the smallest thing peMetadata.ts accepts, not a loadable assembly. A
 * ClassLayout table can be added because a wrong row size there once misaligned every table
 * above it, and a fixture that never contains one would never catch that again.
 */

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};
const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf);

/**
 * @param {object} o
 * @param {string} o.name             the assembly's own name
 * @param {string[]} [o.refs]         assemblies it references
 * @param {string[]} [o.resources]    embedded resource names
 * @param {number} [o.classLayoutRows] ClassLayout rows to include (regression guard)
 * @param {boolean} [o.native]        no CLI header at all, like a native DLL
 * @param {boolean} [o.corruptTables] declare a table no reader knows, so the tables cannot be laid out
 */
function buildAssembly({ name, refs = [], resources = [], classLayoutRows = 0, native = false, corruptTables = false }) {
  // --- heaps -----------------------------------------------------------------
  const strParts = [Buffer.from([0])];
  let strLen = 1;
  const str = (s) => {
    const idx = strLen;
    const b = Buffer.from(`${s}\0`, "utf8");
    strParts.push(b);
    strLen += b.length;
    return idx;
  };
  const moduleName = str(`${name}.dll`);
  const asmName = str(name);
  const refIdx = refs.map((r) => str(r));
  const resIdx = resources.map((r) => str(r));
  const strings = pad4(Buffer.concat(strParts));
  const blob = pad4(Buffer.from([0]));
  const guid = Buffer.alloc(16, 0xab);
  const us = pad4(Buffer.from([0]));

  // --- #~ ---------------------------------------------------------------------
  const present = [
    [0x00, 1],
    ...(classLayoutRows ? [[0x0f, classLayoutRows]] : []),
    [0x20, 1],
    ...(refs.length ? [[0x23, refs.length]] : []),
    ...(resources.length ? [[0x28, resources.length]] : []),
    ...(corruptTables ? [[0x2d, 1]] : [])
  ];
  let lo = 0;
  let hi = 0;
  for (const [t] of present) {
    if (t < 32) lo |= 1 << t;
    else hi |= 1 << (t - 32);
  }
  const rows = [];
  // Module: Generation, Name, Mvid, EncId, EncBaseId
  rows.push(u16(0), u16(moduleName), u16(1), u16(0), u16(0));
  // ClassLayout: PackingSize (2), ClassSize (4), Parent
  for (let i = 0; i < classLayoutRows; i++) rows.push(u16(1), u32(64), u16(1));
  // Assembly: HashAlgId, Major, Minor, Build, Revision, Flags, PublicKey, Name, Culture
  rows.push(u32(0x8004), u16(1), u16(2), u16(3), u16(4), u32(0), u16(0), u16(asmName), u16(0));
  // AssemblyRef: Major, Minor, Build, Revision, Flags, PublicKeyOrToken, Name, Culture, HashValue
  for (const idx of refIdx) rows.push(u16(1), u16(0), u16(0), u16(0), u32(0), u16(0), u16(idx), u16(0), u16(0));
  // ManifestResource: Offset, Flags, Name, Implementation (0 = this file)
  for (const idx of resIdx) rows.push(u32(0), u32(1), u16(idx), u16(0));
  if (corruptTables) rows.push(u32(0));

  const tilde = pad4(
    Buffer.concat([
      u32(0), // reserved
      Buffer.from([2, 0]), // major, minor
      Buffer.from([0]), // heap sizes: every index is 2 bytes
      Buffer.from([1]), // reserved
      u32(lo),
      u32(hi),
      u32(0),
      u32(0), // sorted
      ...present.map(([, n]) => u32(n)),
      ...rows
    ])
  );

  // --- metadata root ----------------------------------------------------------
  const version = Buffer.alloc(12);
  version.write("v4.0.30319");
  const streams = [
    ["#~", tilde],
    ["#Strings", strings],
    ["#US", us],
    ["#GUID", guid],
    ["#Blob", blob]
  ];
  const headerFixed = 4 + 2 + 2 + 4 + 4 + version.length + 2 + 2;
  const nameBytes = (n) => pad4(Buffer.from(`${n}\0`, "ascii"));
  const headersLen = streams.reduce((sum, [n]) => sum + 8 + nameBytes(n).length, 0);
  let offset = headerFixed + headersLen;
  const streamHeaders = [];
  for (const [n, data] of streams) {
    streamHeaders.push(u32(offset), u32(data.length), nameBytes(n));
    offset += data.length;
  }
  const metadata = Buffer.concat([
    Buffer.from("BSJB", "ascii"),
    u16(1),
    u16(1),
    u32(0),
    u32(version.length),
    version,
    u16(0),
    u16(streams.length),
    ...streamHeaders,
    ...streams.map(([, d]) => d)
  ]);

  // --- PE wrapper -------------------------------------------------------------
  const SECTION_RVA = 0x2000;
  const RAW_START = 0x200;
  const cli = Buffer.alloc(72);
  cli.writeUInt32LE(72, 0);
  cli.writeUInt16LE(2, 4);
  cli.writeUInt16LE(5, 6);
  cli.writeUInt32LE(SECTION_RVA + 72, 8); // metadata RVA
  cli.writeUInt32LE(metadata.length, 12);
  cli.writeUInt32LE(1, 16); // ILONLY
  const raw = Buffer.concat([cli, metadata]);
  const rawPadded = Buffer.concat([raw, Buffer.alloc((0x200 - (raw.length % 0x200)) % 0x200)]);

  const headers = Buffer.alloc(RAW_START);
  headers.write("MZ", 0, "ascii");
  headers.writeUInt32LE(0x80, 0x3c);
  headers.write("PE\0\0", 0x80, "ascii");
  const coff = 0x84;
  headers.writeUInt16LE(0x14c, coff); // i386
  headers.writeUInt16LE(1, coff + 2); // one section
  headers.writeUInt16LE(224, coff + 16); // PE32 optional header size
  headers.writeUInt16LE(0x2102, coff + 18);
  const opt = coff + 20;
  headers.writeUInt16LE(0x10b, opt); // PE32
  if (!native) {
    headers.writeUInt32LE(SECTION_RVA, opt + 96 + 14 * 8); // CLI header directory
    headers.writeUInt32LE(72, opt + 96 + 14 * 8 + 4);
  }
  const sec = opt + 224;
  headers.write(".text", sec, "ascii");
  headers.writeUInt32LE(raw.length, sec + 8);
  headers.writeUInt32LE(SECTION_RVA, sec + 12);
  headers.writeUInt32LE(rawPadded.length, sec + 16);
  headers.writeUInt32LE(RAW_START, sec + 20);

  return Buffer.concat([headers, rawPadded]);
}

module.exports = { buildAssembly };
