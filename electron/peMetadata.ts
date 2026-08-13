/* ==========================================================================
 * .NET assembly metadata reader.
 *
 * Reads a mod's declared identity out of the actual CLI metadata tables rather than by
 * scanning the file for plausible-looking strings.
 *
 * Why this exists: the previous approach extracted every printable string from the DLL and
 * guessed which was the GUID, which the name, and which the version, using regexes and
 * adjacency. That fails in ways that are invisible at the time:
 *
 *   - It cannot tell a mod's own GUID from a DEPENDENCY's GUID. Both are lowercase
 *     reverse-domain strings sitting near each other in the blob heap.
 *   - It relies on field ORDER for server mods, which varies between mods by the same
 *     author, so the code had to classify by shape and hope.
 *   - Measured on a real 54-mod install: 10 mods yielded no GUID at all, every one of
 *     which has perfectly readable CLI metadata. Those 10 accounted for both unmatched
 *     mods and 5 of the 7 unconfirmed guesses.
 *
 * Reading the metadata properly removes the guesswork: an attribute argument is exactly
 * what the author wrote, in a known position, with no sibling strings to confuse it.
 *
 * Layout references are ECMA-335 (partitions II.24 and II.25).
 * ========================================================================== */

export interface AssemblyModMetadata {
  guid?: string;
  name?: string;
  author?: string;
  version?: string;
  sptVersion?: string;
  /**
   * The assembly's own version, from AssemblyInformationalVersion (falling back to
   * AssemblyFileVersion). This is a LAST RESORT and is returned separately from `version`
   * on purpose — callers must decide whether to trust it.
   *
   * Why separate: the version compiled into an assembly is not always the version the
   * author published. A mod checked during earlier work declared 0.0.1.0 while shipping as
   * 2.0.0, because the author never bumped the assembly. Preferring it over a declared
   * version would make good data worse.
   *
   * Why collect it at all: for mods that declare no version anywhere else it is the only
   * signal that exists, and it is often right. Measured across the four mods on the
   * reference install that declare nothing:
   *   Epic_Shaders  1.0.1      == Forge's 1.0.1      (exact)
   *   EpicsAIO      4.0.7      vs Forge's 4.0.8      (a genuine pending update)
   *   WTT-CAG       1.0.0-pre1 vs Forge's 1.0.0+pre2 (one pre-release behind)
   *   fika-server   2.0.9      vs Forge's 2.4.0      (behind, or simply unmaintained)
   * Without it those four have no version at all and drop out of update checking.
   */
  assemblyVersion?: string;
}

/* --- PE structure ------------------------------------------------------------------ */

interface Section {
  virtualAddress: number;
  virtualSize: number;
  rawAddress: number;
  rawSize: number;
}

/** Maps a relative virtual address to a file offset using the section table. */
function rvaToOffset(sections: Section[], rva: number): number | null {
  for (const s of sections) {
    // Use the larger of virtual and raw size: sections are commonly zero-padded on disk,
    // and a strict virtualSize check drops RVAs that are legitimately present in the file.
    const size = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.virtualAddress && rva < s.virtualAddress + size) {
      return rva - s.virtualAddress + s.rawAddress;
    }
  }
  return null;
}

interface CliImage {
  buf: Buffer;
  sections: Section[];
  /** file offset of the metadata root ("BSJB") */
  metadataRoot: number;
  streams: Map<string, { offset: number; size: number }>;
}

function parseCliImage(buf: Buffer): CliImage | null {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // not "MZ"

  const lfanew = buf.readUInt32LE(0x3c);
  if (lfanew <= 0 || lfanew + 24 > buf.length) return null;
  if (buf.readUInt32LE(lfanew) !== 0x00004550) return null; // not "PE\0\0"

  const coff = lfanew + 4;
  const numberOfSections = buf.readUInt16LE(coff + 2);
  const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16);
  const optional = coff + 20;
  if (optional + sizeOfOptionalHeader > buf.length) return null;

  const magic = buf.readUInt16LE(optional);
  // PE32 keeps the data directories at +96, PE32+ at +112 (the extra 16 bytes are the
  // widened image-base and stack/heap fields).
  const dirBase = optional + (magic === 0x20b ? 112 : 96);
  const CLI_DIRECTORY = 14;
  if (dirBase + CLI_DIRECTORY * 8 + 8 > buf.length) return null;
  const cliRva = buf.readUInt32LE(dirBase + CLI_DIRECTORY * 8);
  if (cliRva === 0) return null; // native DLL — no managed metadata

  const sectionTable = optional + sizeOfOptionalHeader;
  const sections: Section[] = [];
  for (let i = 0; i < numberOfSections; i++) {
    const s = sectionTable + i * 40;
    if (s + 40 > buf.length) return null;
    sections.push({
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawAddress: buf.readUInt32LE(s + 20)
    });
  }

  const cliOffset = rvaToOffset(sections, cliRva);
  if (cliOffset === null || cliOffset + 16 > buf.length) return null;
  const metadataRva = buf.readUInt32LE(cliOffset + 8);
  const metadataRoot = rvaToOffset(sections, metadataRva);
  if (metadataRoot === null || metadataRoot + 20 > buf.length) return null;
  if (buf.readUInt32LE(metadataRoot) !== 0x424a5342) return null; // not "BSJB"

  // Metadata root: signature(4) major(2) minor(2) reserved(4) versionLength(4) version[..]
  const versionLength = buf.readUInt32LE(metadataRoot + 12);
  let p = metadataRoot + 16 + versionLength;
  p += (4 - (p % 4)) % 4; // the version string is padded to a 4-byte boundary
  if (p + 4 > buf.length) return null;
  const streamCount = buf.readUInt16LE(p + 2);
  p += 4;

  const streams = new Map<string, { offset: number; size: number }>();
  for (let i = 0; i < streamCount; i++) {
    if (p + 8 > buf.length) return null;
    const offset = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    p += 8;
    let end = p;
    while (end < buf.length && buf[end] !== 0) end++;
    const name = buf.toString("ascii", p, end);
    p = end + 1;
    p += (4 - ((p - metadataRoot) % 4)) % 4; // names are padded to 4 bytes
    streams.set(name, { offset: metadataRoot + offset, size });
  }

  return { buf, sections, metadataRoot, streams };
}

/* --- Metadata tables --------------------------------------------------------------- */

const T = {
  Module: 0x00,
  TypeRef: 0x01,
  TypeDef: 0x02,
  Field: 0x04,
  MethodDef: 0x06,
  Param: 0x08,
  InterfaceImpl: 0x09,
  MemberRef: 0x0a,
  CustomAttribute: 0x0c
} as const;

/**
 * Column descriptors. Fixed-width columns are a byte count; the rest are symbolic and
 * resolved once heap sizes and row counts are known.
 */
type Col =
  | number // literal byte width
  | "string"
  | "guid"
  | "blob"
  | { table: number } // simple index into one table
  | { readonly coded: readonly number[]; readonly bits: number }; // coded index across several tables

const CODED = {
  TypeDefOrRef: { coded: [0x02, 0x01, 0x1b], bits: 2 },
  HasConstant: { coded: [0x04, 0x08, 0x17], bits: 2 },
  HasCustomAttribute: {
    coded: [
      0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27,
      0x28, 0x00, 0x00, 0x00
    ],
    bits: 5
  },
  HasFieldMarshal: { coded: [0x04, 0x08], bits: 1 },
  HasDeclSecurity: { coded: [0x02, 0x06, 0x20], bits: 2 },
  MemberRefParent: { coded: [0x02, 0x01, 0x1a, 0x06, 0x1b], bits: 3 },
  HasSemantics: { coded: [0x0e, 0x17], bits: 1 },
  MethodDefOrRef: { coded: [0x06, 0x0a], bits: 1 },
  MemberForwarded: { coded: [0x04, 0x06], bits: 1 },
  Implementation: { coded: [0x26, 0x23, 0x27], bits: 2 },
  CustomAttributeType: { coded: [0x00, 0x00, 0x06, 0x0a, 0x00], bits: 3 },
  ResolutionScope: { coded: [0x00, 0x1a, 0x23, 0x01], bits: 2 },
  TypeOrMethodDef: { coded: [0x02, 0x06], bits: 1 }
} as const;

/**
 * Row layouts for every table that can appear. All of them are needed even though only a
 * few are read: a table's position in the stream is the sum of the sizes of every
 * lower-numbered table present, so an incorrect layout anywhere below the target silently
 * misaligns everything above it.
 */
const TABLE_SCHEMA: Record<number, Col[]> = {
  0x00: [2, "string", "guid", "guid", "guid"], // Module
  0x01: [CODED.ResolutionScope, "string", "string"], // TypeRef
  0x02: [4, "string", "string", CODED.TypeDefOrRef, { table: 0x04 }, { table: 0x06 }], // TypeDef
  0x03: [{ table: 0x04 }], // FieldPtr
  0x04: [2, "string", "blob"], // Field
  0x05: [{ table: 0x06 }], // MethodPtr
  0x06: [4, 2, 2, "string", "blob", { table: 0x08 }], // MethodDef
  0x07: [{ table: 0x08 }], // ParamPtr
  0x08: [2, 2, "string"], // Param
  0x09: [{ table: 0x02 }, CODED.TypeDefOrRef], // InterfaceImpl
  0x0a: [CODED.MemberRefParent, "string", "blob"], // MemberRef
  0x0b: [1, 1, CODED.HasConstant, "blob"], // Constant
  0x0c: [CODED.HasCustomAttribute, CODED.CustomAttributeType, "blob"], // CustomAttribute
  0x0d: [CODED.HasFieldMarshal, "blob"], // FieldMarshal
  0x0e: [2, CODED.HasDeclSecurity, "blob"], // DeclSecurity
  0x0f: [2, 2, { table: 0x02 }], // ClassLayout
  0x10: [4, { table: 0x04 }], // FieldLayout
  0x11: ["blob"], // StandAloneSig
  0x12: [{ table: 0x02 }, { table: 0x14 }], // EventMap
  0x13: [{ table: 0x14 }], // EventPtr
  0x14: [2, "string", CODED.TypeDefOrRef], // Event
  0x15: [{ table: 0x02 }, { table: 0x17 }], // PropertyMap
  0x16: [{ table: 0x17 }], // PropertyPtr
  0x17: [2, "string", "blob"], // Property
  0x18: [2, { table: 0x06 }, CODED.HasSemantics], // MethodSemantics
  0x19: [{ table: 0x02 }, CODED.MethodDefOrRef, CODED.MethodDefOrRef], // MethodImpl
  0x1a: ["string"], // ModuleRef
  0x1b: ["blob"], // TypeSpec
  0x1c: [2, CODED.MemberForwarded, "string", { table: 0x1a }], // ImplMap
  0x1d: [4, { table: 0x04 }], // FieldRVA
  0x1e: [4], // EncLog (unused shape, kept for alignment safety)
  0x1f: [4], // EncMap
  0x20: [4, 2, 2, 2, 2, 4, "blob", "string", "string"], // Assembly
  0x21: [4], // AssemblyProcessor
  0x22: [4, 4, 4], // AssemblyOS
  0x23: [2, 2, 2, 2, 4, "blob", "string", "string", "blob"], // AssemblyRef
  0x24: [4, { table: 0x23 }], // AssemblyRefProcessor
  0x25: [4, 4, 4, { table: 0x23 }], // AssemblyRefOS
  0x26: [4, "string", "string", CODED.Implementation], // File
  0x27: [4, 4, "string", "string", CODED.Implementation], // ExportedType
  0x28: [4, 4, "string", CODED.Implementation], // ManifestResource
  0x29: [{ table: 0x02 }, { table: 0x02 }], // NestedClass
  0x2a: [2, 2, CODED.TypeOrMethodDef, "string"], // GenericParam
  0x2b: ["blob"], // MethodSpec (approximate: MethodDefOrRef + blob, fixed below)
  0x2c: [{ table: 0x2a }, CODED.TypeDefOrRef] // GenericParamConstraint
};
// MethodSpec is MethodDefOrRef + blob; declared here to keep the literal above readable.
TABLE_SCHEMA[0x2b] = [CODED.MethodDefOrRef, "blob"];

interface Tables {
  image: CliImage;
  rowCounts: number[];
  /** file offset of each present table's first row */
  tableOffsets: number[];
  rowSizes: number[];
  stringsOffset: number;
  blobOffset: number;
  stringIndexSize: number;
  blobIndexSize: number;
  guidIndexSize: number;
}

function parseTables(image: CliImage): Tables | null {
  const meta = image.streams.get("#~") ?? image.streams.get("#-");
  const strings = image.streams.get("#Strings");
  const blob = image.streams.get("#Blob");
  if (!meta || !strings || !blob) return null;

  const buf = image.buf;
  const heapSizes = buf[meta.offset + 6];
  const stringIndexSize = heapSizes & 0x01 ? 4 : 2;
  const guidIndexSize = heapSizes & 0x02 ? 4 : 2;
  const blobIndexSize = heapSizes & 0x04 ? 4 : 2;

  const validLo = buf.readUInt32LE(meta.offset + 8);
  const validHi = buf.readUInt32LE(meta.offset + 12);

  const rowCounts: number[] = new Array(64).fill(0);
  let p = meta.offset + 24;
  for (let i = 0; i < 64; i++) {
    const present = i < 32 ? (validLo >>> i) & 1 : (validHi >>> (i - 32)) & 1;
    if (!present) continue;
    if (p + 4 > buf.length) return null;
    rowCounts[i] = buf.readUInt32LE(p);
    p += 4;
  }

  const indexSizeFor = (col: Col): number => {
    if (typeof col === "number") return col;
    if (col === "string") return stringIndexSize;
    if (col === "guid") return guidIndexSize;
    if (col === "blob") return blobIndexSize;
    if ("table" in col) return rowCounts[col.table] >= 1 << 16 ? 4 : 2;
    // A coded index is 2 bytes only while every referenced table fits in the bits left
    // after the tag.
    const maxRows = Math.max(...col.coded.map((t) => rowCounts[t] ?? 0));
    return maxRows >= 1 << (16 - col.bits) ? 4 : 2;
  };

  const rowSizes: number[] = new Array(64).fill(0);
  for (let i = 0; i < 64; i++) {
    if (!rowCounts[i]) continue;
    const schema = TABLE_SCHEMA[i];
    if (!schema) return null; // unknown table — refuse rather than misalign silently
    rowSizes[i] = schema.reduce((sum: number, c: Col) => sum + indexSizeFor(c), 0);
  }

  const tableOffsets: number[] = new Array(64).fill(0);
  let cursor = p;
  for (let i = 0; i < 64; i++) {
    if (!rowCounts[i]) continue;
    tableOffsets[i] = cursor;
    cursor += rowSizes[i] * rowCounts[i];
  }
  if (cursor > buf.length) return null;

  return {
    image,
    rowCounts,
    tableOffsets,
    rowSizes,
    stringsOffset: strings.offset,
    blobOffset: blob.offset,
    stringIndexSize,
    blobIndexSize,
    guidIndexSize
  };
}

/** Reads the columns of one row as raw numbers, in declaration order. */
function readRow(t: Tables, table: number, rowIndex: number): number[] | null {
  if (rowIndex < 1 || rowIndex > t.rowCounts[table]) return null;
  const schema = TABLE_SCHEMA[table];
  const buf = t.image.buf;
  let p = t.tableOffsets[table] + (rowIndex - 1) * t.rowSizes[table];
  const out: number[] = [];
  for (const col of schema) {
    let size: number;
    if (typeof col === "number") size = col;
    else if (col === "string") size = t.stringIndexSize;
    else if (col === "guid") size = t.guidIndexSize;
    else if (col === "blob") size = t.blobIndexSize;
    else if ("table" in col) size = t.rowCounts[col.table] >= 1 << 16 ? 4 : 2;
    else {
      const maxRows = Math.max(...col.coded.map((x) => t.rowCounts[x] ?? 0));
      size = maxRows >= 1 << (16 - col.bits) ? 4 : 2;
    }
    if (p + size > buf.length) return null;
    out.push(size === 2 ? buf.readUInt16LE(p) : size === 4 ? buf.readUInt32LE(p) : buf.readUInt8(p));
    p += size;
  }
  return out;
}

function readString(t: Tables, index: number): string {
  const buf = t.image.buf;
  let end = t.stringsOffset + index;
  while (end < buf.length && buf[end] !== 0) end++;
  return buf.toString("utf8", t.stringsOffset + index, end);
}

/** Decodes ECMA-335's compressed unsigned integer. */
function readCompressedUInt(buf: Buffer, p: number): { value: number; next: number } | null {
  if (p >= buf.length) return null;
  const b0 = buf[p];
  if ((b0 & 0x80) === 0) return { value: b0, next: p + 1 };
  if ((b0 & 0xc0) === 0x80) {
    if (p + 1 >= buf.length) return null;
    return { value: ((b0 & 0x3f) << 8) | buf[p + 1], next: p + 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (p + 3 >= buf.length) return null;
    return { value: ((b0 & 0x1f) << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3], next: p + 4 };
  }
  return null;
}

function blobAt(t: Tables, index: number): Buffer | null {
  const buf = t.image.buf;
  const header = readCompressedUInt(buf, t.blobOffset + index);
  if (!header) return null;
  const start = header.next;
  const end = start + header.value;
  if (end > buf.length) return null;
  return buf.subarray(start, end);
}

/** Decodes the fixed string arguments of a custom-attribute blob. */
function decodeStringArgs(blob: Buffer, count: number): (string | null)[] {
  const out: (string | null)[] = [];
  if (blob.length < 2 || blob.readUInt16LE(0) !== 0x0001) return out; // prolog must be 0x0001
  let p = 2;
  for (let i = 0; i < count; i++) {
    if (p >= blob.length) break;
    if (blob[p] === 0xff) {
      out.push(null); // explicit null string
      p += 1;
      continue;
    }
    const len = readCompressedUInt(blob, p);
    if (!len) break;
    const start = len.next;
    const end = start + len.value;
    if (end > blob.length) break;
    out.push(blob.toString("utf8", start, end));
    p = end;
  }
  return out;
}

/* --- Client mods: the BepInPlugin attribute ----------------------------------------- */

/**
 * [BepInPlugin(GUID, Name, Version)] on the plugin class.
 *
 * Read from the CustomAttribute table, this is unambiguous: the constructor is resolved by
 * name, and the three values come out in declared order. The old string-scan could not
 * distinguish this from a [BepInDependency("some.other.mod")] sitting nearby — which is
 * exactly how a mod ended up matched to its dependency rather than to itself.
 */
function readBepInPlugin(t: Tables): AssemblyModMetadata | null {
  const caCount = t.rowCounts[T.CustomAttribute];
  if (!caCount) return null;

  for (let i = 1; i <= caCount; i++) {
    const row = readRow(t, T.CustomAttribute, i);
    if (!row) continue;
    const [, typeCoded, valueIdx] = row;

    // CustomAttributeType: 3-bit tag; 2 = MethodDef, 3 = MemberRef.
    const tag = typeCoded & 0x07;
    const rowIdx = typeCoded >>> 3;
    let typeName: string | null = null;

    if (tag === 3) {
      const mr = readRow(t, T.MemberRef, rowIdx);
      if (!mr) continue;
      const [classCoded] = mr;
      // MemberRefParent: 3-bit tag; 1 = TypeRef, 0 = TypeDef.
      const pTag = classCoded & 0x07;
      const pRow = classCoded >>> 3;
      if (pTag === 1) {
        const tr = readRow(t, T.TypeRef, pRow);
        if (tr) typeName = readString(t, tr[1]);
      } else if (pTag === 0) {
        const td = readRow(t, T.TypeDef, pRow);
        if (td) typeName = readString(t, td[1]);
      }
    } else if (tag === 2) {
      // A MethodDef constructor means the attribute type is defined in this assembly;
      // finding its declaring type means walking TypeDef method ranges, which is not worth
      // it — BepInPlugin always comes from the referenced BepInEx assembly.
      continue;
    }

    if (typeName !== "BepInPlugin") continue;

    const blob = blobAt(t, valueIdx);
    if (!blob) continue;
    const [guid, name, version] = decodeStringArgs(blob, 3);
    if (!guid) continue;
    return {
      guid: guid ?? undefined,
      name: name ?? undefined,
      version: version ?? undefined
    };
  }
  return null;
}

/**
 * Reads a single-string assembly-level attribute, e.g. [assembly: AssemblyInformationalVersion("1.0.1+sha")].
 * Same CustomAttribute walk as the BepInPlugin reader, matching on the attribute type name.
 */
function readAssemblyAttributeString(t: Tables, attributeName: string): string | undefined {
  const caCount = t.rowCounts[T.CustomAttribute];
  if (!caCount) return undefined;

  for (let i = 1; i <= caCount; i++) {
    const row = readRow(t, T.CustomAttribute, i);
    if (!row) continue;
    const [, typeCoded, valueIdx] = row;
    if ((typeCoded & 0x07) !== 3) continue; // MemberRef only — these attributes are referenced, not defined here
    const mr = readRow(t, T.MemberRef, typeCoded >>> 3);
    if (!mr) continue;
    const [classCoded] = mr;
    if ((classCoded & 0x07) !== 1) continue; // TypeRef
    const tr = readRow(t, T.TypeRef, classCoded >>> 3);
    if (!tr || readString(t, tr[1]) !== attributeName) continue;

    const blob = blobAt(t, valueIdx);
    if (!blob) continue;
    const [value] = decodeStringArgs(blob, 1);
    if (value) return value;
  }
  return undefined;
}

/**
 * Prefers AssemblyInformationalVersion: it carries the real semver including pre-release
 * tags ("1.0.0-pre1"), which AssemblyFileVersion cannot represent — it is limited to four
 * numbers, so "1.0.0-pre1" would flatten to "1.0.0" and compare equal to the release.
 *
 * The "+buildmetadata" suffix is stripped: semver ignores it for precedence, and Forge
 * publishes versions without it.
 */
function readAssemblyVersion(t: Tables): string | undefined {
  const raw =
    readAssemblyAttributeString(t, "AssemblyInformationalVersionAttribute") ??
    readAssemblyAttributeString(t, "AssemblyFileVersionAttribute");
  if (!raw) return undefined;
  const trimmed = raw.split("+")[0].trim();
  // A bare "1.0.0.0" is the compiler's default and means the author never set one, so it
  // says nothing about what was published.
  if (!trimmed || trimmed === "1.0.0.0" || trimmed === "0.0.0.0") return undefined;
  return trimmed;
}

/**
 * Both assembly version attributes, unmerged.
 *
 * `readAssemblyVersion` above collapses them into one best guess, which is right for a mod. It is
 * wrong for reading an application's version, where the two say different things and the caller
 * needs to choose: SPT.Server.exe carries
 *   AssemblyInformationalVersion = "4.0.13-RELEASE+2891fd4.20260302.…"
 *   AssemblyFileVersion          = "4.0.13"
 * and only the second is a version a catalogue can be filtered by.
 */
export function readAssemblyVersionStrings(buf: Buffer): { informational?: string; file?: string } | null {
  try {
    const image = parseCliImage(buf);
    if (!image) return null;
    const tables = parseTables(image);
    if (!tables) return null;
    return {
      informational: readAssemblyAttributeString(tables, "AssemblyInformationalVersionAttribute"),
      file: readAssemblyAttributeString(tables, "AssemblyFileVersionAttribute")
    };
  } catch {
    return null;
  }
}

/* --- Server mods: AbstractModMetadata ----------------------------------------------- */

/**
 * SPT 4.0 server mods declare a class deriving from AbstractModMetadata and assign the
 * values in its constructor. Unlike an attribute, these are not stored as data — they are
 * `ldstr` instructions in the constructor's IL, so the values must be read from the method
 * body.
 *
 * The property each string belongs to is determined by the `call set_X` that consumes it,
 * which is what makes this reliable where the old approach was not: the previous code had
 * to guess field roles by shape because "the field ORDER VARIES from mod to mod". Reading
 * the setter name removes the guessing entirely.
 */
function readAbstractModMetadata(t: Tables): AssemblyModMetadata | null {
  const typeDefCount = t.rowCounts[T.TypeDef];
  if (!typeDefCount) return null;

  // Find a type whose base class is named AbstractModMetadata.
  let target: { methodStart: number; methodEnd: number } | null = null;
  for (let i = 1; i <= typeDefCount; i++) {
    const td = readRow(t, T.TypeDef, i);
    if (!td) continue;
    const extendsCoded = td[3];
    const tag = extendsCoded & 0x03;
    const rowIdx = extendsCoded >>> 2;
    let baseName: string | null = null;
    if (tag === 1) {
      const tr = readRow(t, T.TypeRef, rowIdx);
      if (tr) baseName = readString(t, tr[1]);
    } else if (tag === 0) {
      const bd = readRow(t, T.TypeDef, rowIdx);
      if (bd) baseName = readString(t, bd[1]);
    }
    if (baseName !== "AbstractModMetadata") continue;

    const methodStart = td[5];
    const next = readRow(t, T.TypeDef, i + 1);
    const methodEnd = next ? next[5] : t.rowCounts[T.MethodDef] + 1;
    target = { methodStart, methodEnd };
    break;
  }
  if (!target) return null;

  const found: AssemblyModMetadata = {};
  for (let m = target.methodStart; m < target.methodEnd; m++) {
    const md = readRow(t, T.MethodDef, m);
    if (!md) continue;
    const [rva, , , nameIdx] = md;
    if (rva === 0) continue;
    const methodName = readString(t, nameIdx);
    // Values are assigned in the constructor; property getters that just return a literal
    // are also covered because the same ldstr/ret shape appears there.
    const body = readMethodBody(t, rva);
    if (!body) continue;
    harvestIlStrings(t, body, methodName, found);
  }

  return Object.keys(found).length > 0 ? found : null;
}

/** Returns the IL byte range of a method body, handling both tiny and fat headers. */
function readMethodBody(t: Tables, rva: number): Buffer | null {
  const offset = rvaToOffset(t.image.sections, rva);
  if (offset === null || offset >= t.image.buf.length) return null;
  const buf = t.image.buf;
  const first = buf[offset];
  if ((first & 0x03) === 0x02) {
    // Tiny header: one byte, size in the top 6 bits.
    const size = first >>> 2;
    const start = offset + 1;
    if (start + size > buf.length) return null;
    return buf.subarray(start, start + size);
  }
  if ((first & 0x03) === 0x03) {
    // Fat header: 12 bytes, code size at +4.
    if (offset + 12 > buf.length) return null;
    const headerSize = (buf.readUInt16LE(offset) >>> 12) * 4;
    const codeSize = buf.readUInt32LE(offset + 4);
    const start = offset + headerSize;
    if (start + codeSize > buf.length) return null;
    return buf.subarray(start, start + codeSize);
  }
  return null;
}

/**
 * Walks IL looking for `ldstr <token>` followed by a call to a property setter, and files
 * the string under the property it was assigned to.
 *
 * This is a linear scan rather than a full IL decoder: it tracks the most recent ldstr and
 * attributes it to the next call whose name starts with "set_". That is sufficient for the
 * generated constructor shape (ldarg.0; ldstr "..."; call set_X) and degrades to finding
 * nothing rather than finding something wrong.
 */
/**
 * Calls that wrap a string literal without consuming it — the value still ends up in the
 * field that is stored next. Conversions and constructors only; anything else is treated
 * as consuming the literal, so an unrelated call cannot leak a value into the wrong field.
 */
const CONVERSION_METHODS = new Set(["op_Implicit", "op_Explicit", "Parse", "TryParse", ".ctor"]);

function harvestIlStrings(t: Tables, il: Buffer, methodName: string, out: AssemblyModMetadata): void {
  let pendingString: string | null = null;

  for (let p = 0; p < il.length; ) {
    const op = il[p];

    if (op === 0x72) {
      // ldstr <userstring token>
      if (p + 5 > il.length) break;
      const token = il.readUInt32LE(p + 1);
      pendingString = readUserString(t, token & 0x00ffffff);
      p += 5;
      continue;
    }

    if (op === 0x7d) {
      // stfld <field token>
      //
      // This is the shape auto-property initialisers compile to. SPT 4.0 server mods
      // declare `public override string Name { get; set; } = "..."`, which the compiler
      // lowers to a direct store into the generated backing field rather than a call to
      // the setter — so a scanner that only watches for `call set_X` sees nothing at all.
      // That is why every server mod came back empty on the first attempt.
      if (p + 5 > il.length) break;
      const token = il.readUInt32LE(p + 1);
      if ((token >>> 24) === T.Field && pendingString !== null) {
        const fieldRow = readRow(t, T.Field, token & 0x00ffffff);
        if (fieldRow) {
          // "<ModGuid>k__BackingField" -> "ModGuid"
          const raw = readString(t, fieldRow[1]);
          const backing = /^<(.+)>k__BackingField$/.exec(raw);
          assignMetadataField(backing ? backing[1] : raw, pendingString, out);
        }
      }
      pendingString = null;
      p += 5;
      continue;
    }

    if (op === 0x28 || op === 0x6f || op === 0x73) {
      // call / callvirt / newobj <method token>
      if (p + 5 > il.length) break;
      const token = il.readUInt32LE(p + 1);
      const table = token >>> 24;
      const rowIdx = token & 0x00ffffff;
      let calleeName: string | null = null;
      if (table === T.MethodDef) {
        const md = readRow(t, T.MethodDef, rowIdx);
        if (md) calleeName = readString(t, md[3]);
      } else if (table === T.MemberRef) {
        const mr = readRow(t, T.MemberRef, rowIdx);
        if (mr) calleeName = readString(t, mr[1]);
      }
      if (calleeName && pendingString !== null && calleeName.startsWith("set_")) {
        assignMetadataField(calleeName.slice(4), pendingString, out);
        pendingString = null;
      } else if (calleeName && CONVERSION_METHODS.has(calleeName)) {
        // Transparent: the literal is being converted, not consumed. SPT's
        // AbstractModMetadata types Version as SemanticVersioning.Version rather than a
        // string, so `Version = "3.0.0"` compiles to
        //     ldstr "3.0.0"; call op_Implicit(string)->Version; stfld <Version>k__Backing
        // Treating that op_Implicit as a normal call discarded the literal, and Version
        // came back blank for 13 of 54 mods on the reference install while every other
        // field parsed fine. Keeping the pending string lets the following store claim it.
        p += 5;
        continue;
      } else {
        pendingString = null;
      }
      p += 5;
      continue;
    }

    // A property getter that simply returns a literal: ldstr followed by ret. The property
    // name comes from the method name itself ("get_ModGuid").
    if (op === 0x2a && pendingString !== null && methodName.startsWith("get_")) {
      assignMetadataField(methodName.slice(4), pendingString, out);
      pendingString = null;
      p += 1;
      continue;
    }

    p += ilOperandLength(il, p);
  }
}

function assignMetadataField(property: string, value: string, out: AssemblyModMetadata): void {
  switch (property.toLowerCase()) {
    case "modguid":
    case "guid":
      out.guid ??= value;
      break;
    case "name":
    case "modname":
      out.name ??= value;
      break;
    case "author":
      out.author ??= value;
      break;
    case "version":
    case "modversion":
      out.version ??= value;
      break;
    case "sptversion":
      out.sptVersion ??= value;
      break;
  }
}

function readUserString(t: Tables, index: number): string | null {
  const us = t.image.streams.get("#US");
  if (!us) return null;
  const buf = t.image.buf;
  const header = readCompressedUInt(buf, us.offset + index);
  if (!header) return null;
  const start = header.next;
  // The trailing byte is a flag, not character data; the string itself is UTF-16LE.
  const byteLength = header.value > 0 ? header.value - 1 : 0;
  if (start + byteLength > buf.length) return null;
  return buf.toString("utf16le", start, start + byteLength);
}

/** Byte length of an instruction, used to step over operands we do not care about. */
function ilOperandLength(il: Buffer, p: number): number {
  const op = il[p];
  if (op === 0xfe) return 2; // two-byte opcode prefix; operands handled conservatively
  // Inline int32 / token / float32 style operands.
  if (
    (op >= 0x20 && op <= 0x23) ||
    (op >= 0x28 && op <= 0x29) ||
    (op >= 0x38 && op <= 0x3f) ||
    (op >= 0x6f && op <= 0x73) ||
    (op >= 0x74 && op <= 0x75) ||
    (op >= 0x79 && op <= 0x7b) ||
    (op >= 0x7c && op <= 0x81) ||
    (op >= 0x8c && op <= 0x8d) ||
    op === 0x8f ||
    op === 0xa3 ||
    op === 0xa4 ||
    op === 0xa5 ||
    op === 0xc2 ||
    op === 0xc6 ||
    op === 0xd0
  ) {
    return 5;
  }
  if (op === 0x22) return 5;
  if (op === 0x23) return 9; // ldc.r8
  if (op === 0x21) return 9; // ldc.i8
  if (op === 0x45) return 5; // switch handled crudely; the scan tolerates imprecision
  if (
    (op >= 0x0e && op <= 0x13) ||
    (op >= 0x2b && op <= 0x37) ||
    op === 0x1f ||
    op === 0xdd ||
    op === 0xde
  ) {
    return 2;
  }
  return 1;
}

/* --- Entry point -------------------------------------------------------------------- */

/**
 * Reads mod identity from a .NET assembly. Returns null when the file is not a managed
 * assembly, or when nothing recognisable is declared — callers fall back to the older
 * string-scanning heuristic in that case rather than losing a result outright.
 */
export function readAssemblyModMetadata(buf: Buffer): AssemblyModMetadata | null {
  try {
    const image = parseCliImage(buf);
    if (!image) return null;
    const tables = parseTables(image);
    if (!tables) return null;
    const declared = readAbstractModMetadata(tables) ?? readBepInPlugin(tables);
    const assemblyVersion = readAssemblyVersion(tables);
    // An assembly with NO declared identity still has a version worth having, and returning null
    // here threw it away. That excluded exactly the files that declare nothing — prepatchers,
    // which are not plugins and carry no [BepInPlugin] — so the companion (which reads the
    // assembly version independently) reported a version for them and this side did not, and
    // every prepatcher compared as "can't compare".
    if (!declared) return assemblyVersion ? { assemblyVersion } : null;
    // Never let the assembly version stand in for a declared one — the caller decides whether
    // to fall back to it.
    return { ...declared, assemblyVersion };
  } catch {
    // A malformed or obfuscated assembly must never break a scan of the whole mod list.
    return null;
  }
}
