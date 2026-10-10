const fs = require("node:fs");
const path = require("node:path");

const sourceDirectory = path.resolve(__dirname, "../../config/launch1000");
const targetDirectory = path.resolve(__dirname, "../lib/config/launch1000");
const files = ["final800-manifest.json", "taxonomy-proposals.json"];

for (const file of files) {
  const source = path.join(sourceDirectory, file);
  const target = path.join(targetDirectory, file);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing Launch-1000 snapshot source: ${source}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}
