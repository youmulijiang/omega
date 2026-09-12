import { readFileSync, writeFileSync } from "node:fs";
import { PhotonImage, SamplingFilter, resize } from "@silvia-odwyer/photon-node";

const [sourcePath, outputPath] = process.argv.slice(2);

if (!sourcePath || !outputPath) {
	throw new Error("Usage: node scripts/create-windows-icon.mjs <source-image> <output.ico>");
}

const source = readFileSync(sourcePath);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (source.length >= 6 && source.readUInt16LE(0) === 0 && source.readUInt16LE(2) === 1) {
	const count = source.readUInt16LE(4);
	if (count === 0 || source.length < 6 + count * 16) {
		throw new Error(`Invalid Windows ICO directory: ${sourcePath}`);
	}
	writeFileSync(outputPath, source);
	process.exit(0);
}
if (!source.subarray(0, pngSignature.length).equals(pngSignature)) {
	throw new Error(`Windows icon source must be an ICO or PNG image: ${sourcePath}`);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const image = PhotonImage.new_from_byteslice(source);
const images = sizes.map((size) => {
	const resized = resize(image, size, size, SamplingFilter.Lanczos3);
	try {
		return Buffer.from(resized.get_bytes());
	} finally {
		resized.free();
	}
});
image.free();

// ICO files can contain multiple PNG-compressed images. Windows chooses the
// closest representation for Explorer, shortcuts, the taskbar, and dialogs.
const directorySize = 6 + images.length * 16;
const header = Buffer.alloc(directorySize);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);

let imageOffset = directorySize;
for (const [index, png] of images.entries()) {
	const entryOffset = 6 + index * 16;
	const size = sizes[index];
	header.writeUInt8(size === 256 ? 0 : size, entryOffset);
	header.writeUInt8(size === 256 ? 0 : size, entryOffset + 1);
	header.writeUInt8(0, entryOffset + 2);
	header.writeUInt8(0, entryOffset + 3);
	header.writeUInt16LE(1, entryOffset + 4);
	header.writeUInt16LE(32, entryOffset + 6);
	header.writeUInt32LE(png.length, entryOffset + 8);
	header.writeUInt32LE(imageOffset, entryOffset + 12);
	imageOffset += png.length;
}

writeFileSync(outputPath, Buffer.concat([header, ...images]));
