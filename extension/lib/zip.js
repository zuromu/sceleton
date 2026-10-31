// A tiny .zip maker, so "export everything" can hand you one file.
//
// It doesn't compress anything ("store" mode). PDFs and slides are already
// compressed, so this keeps the code short and fast and the zip still opens
// everywhere (Finder, Windows Explorer, unzip).
//
//   const blob = makeZip([{ name: 'a/hello.txt', data: 'hi' }, { name: 'b.pdf', data: uint8array }]);

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// The checksum every zip file needs for each file inside it.
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// Two files can't share a path in a zip, so the second one gets " (2)".
function uniquePaths(entries) {
  const used = new Set();
  return entries.map((e) => {
    let name = String(e.name).replace(/^\/+/, '');
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const slash = name.lastIndexOf('/');
      const hasExt = dot > slash + 1;
      const base = hasExt ? name.slice(0, dot) : name;
      const ext = hasExt ? name.slice(dot) : '';
      let n = 2;
      while (used.has(`${base} (${n})${ext}`.toLowerCase())) n++;
      name = `${base} (${n})${ext}`;
    }
    used.add(name.toLowerCase());
    return { ...e, name };
  });
}

export function makeZip(entries, date = new Date()) {
  const { time, date: day } = dosDateTime(date);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of uniquePaths(entries)) {
    const name = encoder.encode(e.name);
    const bytes = typeof e.data === 'string' ? encoder.encode(e.data) : e.data;
    const crc = crc32(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);       // version needed
    local.setUint16(6, 0x0800, true);   // names are UTF-8
    local.setUint16(8, 0, true);        // no compression
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);       // version made by
    entry.setUint16(6, 20, true);       // version needed
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);  // where this file's header starts
    central.push(entry.buffer, name);

    offset += 30 + name.length + bytes.length;
  }

  const centralSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length / 2, true);
  end.setUint16(10, central.length / 2, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
