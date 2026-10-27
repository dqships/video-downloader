// Zips dist/ for the Chrome Web Store, without source maps:
// release/vidzilla-<version>.zip. Usage: pnpm package (builds first).
// Plain Node, so it works the same on macOS, Windows and Linux.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const { version } = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

const files = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.endsWith(".map"))
  .map((e) => join(e.parentPath, e.name))
  .sort();

// A minimal ZIP writer: deflated entries, a central directory, no extras.
const local = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(relative(dist, file).split(sep).join("/"));
  const data = readFileSync(file);
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0x0800, 6); // UTF-8 names
  head.writeUInt16LE(8, 8); // deflate
  head.writeUInt32LE(0x00210000, 10); // 1980-01-01, so builds zip identically
  head.writeUInt32LE(crc, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(data.length, 22);
  head.writeUInt16LE(name.length, 26);
  local.push(head, name, packed);

  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0);
  entry.writeUInt16LE(20, 4);
  entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x0800, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt32LE(0x00210000, 12);
  entry.writeUInt32LE(crc, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, name);
  offset += head.length + name.length + packed.length;
}
const dir = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dir.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(root, "release"), { recursive: true });
const out = join(root, "release", `vidzilla-${version}.zip`);
writeFileSync(out, Buffer.concat([...local, dir, end]));
console.log(`${relative(root, out)}: ${files.length} files`);
