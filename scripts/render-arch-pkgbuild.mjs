#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTemplatePath = path.join(
  rootDir,
  "packaging/arch/jupiter-bin/PKGBUILD.in",
);

const archConfig = {
  x86_64: {
    distFile: "Jupiter-${pkgver}-linux-x64.deb",
    sourceVar: "source_x86_64",
    shaVar: "sha256sums_x86_64",
  },
  aarch64: {
    distFile: "Jupiter-${pkgver}-linux-arm64.deb",
    sourceVar: "source_aarch64",
    shaVar: "sha256sums_aarch64",
  },
};

export function normalizeDesktopTag(value) {
  if (!value || typeof value !== "string") {
    throw new Error("tag is required");
  }
  if (value.startsWith("desktop-v")) {
    return value;
  }
  if (value.startsWith("v")) {
    return `desktop-${value}`;
  }
  return `desktop-v${value}`;
}

export function versionFromDesktopTag(value) {
  const tag = normalizeDesktopTag(value);
  return tag.replace(/^desktop-v/, "");
}

function quoteArray(values) {
  return values.map((value) => `'${value}'`).join(" ");
}

function validateSha256(arch, sha256) {
  if (!/^[a-fA-F0-9]{64}$/.test(sha256)) {
    throw new Error(`${arch} sha256 must be a 64-character hex digest`);
  }
}

export function renderPkgbuild({ pkgver, pkgrel = "1", sources, template }) {
  if (!pkgver) {
    throw new Error("pkgver is required");
  }
  const entries = Object.entries(sources ?? {}).filter(([, source]) =>
    Boolean(source?.url),
  );
  if (entries.length === 0) {
    throw new Error("at least one source is required");
  }

  const archNames = entries.map(([arch]) => {
    if (!archConfig[arch]) {
      throw new Error(`unsupported Arch package architecture: ${arch}`);
    }
    return arch;
  });

  const sourceLines = [];
  for (const [arch, source] of entries) {
    validateSha256(arch, source.sha256);
    const config = archConfig[arch];
    sourceLines.push(
      `${config.sourceVar}=("${config.distFile}::${source.url}")`,
      `${config.shaVar}=('${source.sha256.toLowerCase()}')`,
    );
  }

  const templateText =
    template ??
    `pkgname=jupiter-bin
pkgver=@PKGVER@
pkgrel=@PKGREL@
arch=(@ARCH_ARRAY@)
noextract=(@NOEXTRACT_ARRAY@)

@SOURCE_LINES@
`;

  return templateText
    .replaceAll("@PKGVER@", pkgver)
    .replaceAll("@PKGREL@", pkgrel)
    .replaceAll("@ARCH_ARRAY@", quoteArray(archNames))
    .replaceAll(
      "@NOEXTRACT_ARRAY@",
      quoteArray(archNames.map((arch) => archConfig[arch].distFile)),
    )
    .replaceAll("@SOURCE_LINES@", sourceLines.join("\n"));
}

function parseArgs(argv) {
  const parsed = {
    pkgrel: "1",
    template: defaultTemplatePath,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    switch (key) {
      case "--tag":
        parsed.tag = value;
        i += 1;
        break;
      case "--pkgver":
        parsed.pkgver = value;
        i += 1;
        break;
      case "--pkgrel":
        parsed.pkgrel = value;
        i += 1;
        break;
      case "--template":
        parsed.template = value;
        i += 1;
        break;
      case "--out":
        parsed.out = value;
        i += 1;
        break;
      case "--x64-url":
        parsed.x64Url = value;
        i += 1;
        break;
      case "--x64-sha256":
        parsed.x64Sha256 = value;
        i += 1;
        break;
      case "--arm64-url":
        parsed.arm64Url = value;
        i += 1;
        break;
      case "--arm64-sha256":
        parsed.arm64Sha256 = value;
        i += 1;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${key}`);
    }
  }
  return parsed;
}

function usage() {
  return `Usage:
  node scripts/render-arch-pkgbuild.mjs --tag desktop-vX.Y.Z --x64-url URL --x64-sha256 SHA --out PKGBUILD

Options:
  --tag TAG              Desktop release tag. Accepts desktop-vX.Y.Z, vX.Y.Z, or X.Y.Z.
  --pkgver VERSION       Package version. Alternative to --tag.
  --pkgrel REL           Arch package release number. Default: 1.
  --x64-url URL          x86_64 .deb URL or file:// path.
  --x64-sha256 SHA       x86_64 .deb sha256.
  --arm64-url URL        aarch64 .deb URL or file:// path.
  --arm64-sha256 SHA     aarch64 .deb sha256.
  --template PATH        PKGBUILD template path.
  --out PATH             Output PKGBUILD path.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const pkgver = args.pkgver ?? versionFromDesktopTag(args.tag);
  const sources = {};
  if (args.x64Url || args.x64Sha256) {
    sources.x86_64 = { url: args.x64Url, sha256: args.x64Sha256 };
  }
  if (args.arm64Url || args.arm64Sha256) {
    sources.aarch64 = { url: args.arm64Url, sha256: args.arm64Sha256 };
  }
  const template = await readFile(args.template, "utf8");
  const rendered = renderPkgbuild({
    pkgver,
    pkgrel: args.pkgrel,
    sources,
    template,
  });
  if (args.out) {
    await mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await writeFile(args.out, rendered);
  } else {
    process.stdout.write(rendered);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
