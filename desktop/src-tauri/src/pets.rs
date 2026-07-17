use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, OpenOptions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::{Cursor, Read, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_PACKAGES: usize = 64;
const MAX_ROOT_ENTRIES: usize = 128;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_SPRITESHEET_BYTES: u64 = 8 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 512 * 1024;
const V2_ATLAS_WIDTH: u32 = 1536;
const V2_ATLAS_HEIGHT: u32 = 2288;
const MAX_THUMBNAIL_DIMENSION: u32 = 512;
const MAX_CACHE_DIRECTORY_ENTRIES: usize = 512;
const MAX_CACHE_SESSION_ENTRIES: usize = 64;
static PET_SCAN_ACTIVE: AtomicBool = AtomicBool::new(false);
static PET_CACHE_SESSION_ID: OnceLock<String> = OnceLock::new();
static PET_CACHE_STATE: Mutex<PetCacheState> = Mutex::new(PetCacheState {
    allowed_root: None,
    current_assets: Vec::new(),
});

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PetManifest {
    schema_version: Option<u8>,
    id: String,
    display_name: String,
    description: Option<String>,
    sprite_version_number: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCatalogEntry {
    id: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    sprite_version_number: u8,
    sprite_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCatalogError {
    package_id: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetCatalogScan {
    root: String,
    pets: Vec<PetCatalogEntry>,
    errors: Vec<PetCatalogError>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
struct WebpInfo {
    width: u32,
    height: u32,
    animated: bool,
}

struct Candidate {
    package_id: String,
    entry: PetCatalogEntry,
}

struct PetsRoot {
    path: PathBuf,
    dir: Dir,
}

struct PetCacheState {
    allowed_root: Option<PathBuf>,
    current_assets: Vec<PathBuf>,
}

struct PetScanPermit;

impl PetScanPermit {
    fn acquire() -> Result<Self, String> {
        PET_SCAN_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "a custom pet scan is already in progress".into())
    }
}

impl Drop for PetScanPermit {
    fn drop(&mut self) {
        PET_SCAN_ACTIVE.store(false, Ordering::Release);
    }
}

fn open_pets_root_from_home(home: &Path) -> Result<PetsRoot, String> {
    let canonical_home = home
        .canonicalize()
        .map_err(|error| format!("could not resolve home directory: {error}"))?;
    let mut dir = Dir::open_ambient_dir(&canonical_home, ambient_authority())
        .map_err(|error| format!("could not open home directory: {error}"))?;
    let mut current = canonical_home.clone();
    for component in [".jupiter", "pets"] {
        current.push(component);
        match dir.create_dir(component) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(format!("could not create {}: {error}", current.display()));
            }
        }
        let metadata = dir
            .symlink_metadata(component)
            .map_err(|error| format!("metadata failed for {}: {error}", current.display()))?;
        if metadata.file_type().is_symlink() {
            return Err("symbolic links and junctions are not allowed".into());
        }
        if !metadata.is_dir() {
            return Err(format!("{} is not a directory", current.display()));
        }
        dir = dir
            .open_dir_nofollow(component)
            .map_err(|error| format!("could not safely open {}: {error}", current.display()))?;
    }
    Ok(PetsRoot { path: current, dir })
}

fn pets_root_from_home(home: &Path) -> Result<PathBuf, String> {
    open_pets_root_from_home(home).map(|root| root.path)
}

fn prepare_cache_root(path: &Path) -> Result<(PathBuf, Dir), String> {
    std::fs::create_dir_all(path)
        .map_err(|error| format!("could not create pet cache {}: {error}", path.display()))?;
    let metadata = reject_link(path)?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a directory", path.display()));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("could not resolve pet cache {}: {error}", path.display()))?;
    let dir = Dir::open_ambient_dir(&canonical, ambient_authority())
        .map_err(|error| format!("could not open pet cache {}: {error}", canonical.display()))?;
    Ok((canonical, dir))
}

fn is_valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 64 || id.starts_with('.') || id.ends_with('.') {
        return false;
    }
    if !id.bytes().all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
    }) {
        return false;
    }
    let base = id.split('.').next().unwrap_or(id);
    !matches!(
        base,
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

#[cfg(windows)]
fn has_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn has_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn reject_link(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("metadata failed for {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || has_reparse_point(&metadata) {
        return Err("symbolic links and junctions are not allowed".into());
    }
    Ok(metadata)
}

#[cfg(test)]
fn open_read_only_no_follow(path: &Path) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    let file = options
        .open(path)
        .map_err(|error| format!("open failed for {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("metadata failed for {}: {error}", path.display()))?;
    if !metadata.is_file() || has_reparse_point(&metadata) {
        return Err(format!("{} is not a regular file", path.display()));
    }
    Ok(file)
}

#[cfg(test)]
fn read_limited(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let file = open_read_only_no_follow(path)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("metadata failed for {}: {error}", path.display()))?;
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} exceeds the {} byte limit",
            path.display(),
            max_bytes
        ));
    }
    let capacity = usize::try_from(metadata.len().min(max_bytes)).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read failed for {}: {error}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "{} exceeds the {} byte limit",
            path.display(),
            max_bytes
        ));
    }
    Ok(bytes)
}

fn read_cap_limited(dir: &Dir, path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = dir
        .open_with(path, &options)
        .map_err(|error| format!("open failed for {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("metadata failed for {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if metadata.len() > max_bytes {
        return Err(format!(
            "{} exceeds the {} byte limit",
            path.display(),
            max_bytes
        ));
    }
    let capacity = usize::try_from(metadata.len().min(max_bytes)).unwrap_or(0);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read failed for {}: {error}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!(
            "{} exceeds the {} byte limit",
            path.display(),
            max_bytes
        ));
    }
    Ok(bytes)
}

fn read_u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn inspect_webp(bytes: &[u8]) -> Result<WebpInfo, String> {
    if bytes.len() < 20 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err("file is not a WebP image".into());
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8;
    if declared != bytes.len() {
        return Err("WebP container length is invalid".into());
    }

    let mut offset = 12usize;
    let mut canvas = None;
    let mut bitstream = None;
    let mut animated = false;
    while offset + 8 <= declared {
        let chunk = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data_start = offset + 8;
        let data_end = data_start
            .checked_add(size)
            .ok_or("WebP chunk length overflow")?;
        let padded_end = data_end
            .checked_add(size & 1)
            .ok_or("WebP chunk padding overflow")?;
        if padded_end > declared {
            return Err("WebP chunk extends past the container".into());
        }
        let data = &bytes[data_start..data_end];
        match chunk {
            b"VP8X" => {
                if data.len() != 10 || canvas.is_some() {
                    return Err("WebP extended header is invalid or duplicated".into());
                }
                animated |= data[0] & 0x02 != 0;
                canvas = Some((read_u24(&data[4..7]) + 1, read_u24(&data[7..10]) + 1));
            }
            b"VP8 " => {
                if data.len() < 10 || data[3..6] != [0x9d, 0x01, 0x2a] || bitstream.is_some() {
                    return Err("WebP VP8 payload header is invalid or duplicated".into());
                }
                let width = u16::from_le_bytes([data[6], data[7]]) & 0x3fff;
                let height = u16::from_le_bytes([data[8], data[9]]) & 0x3fff;
                bitstream = Some((u32::from(width), u32::from(height)));
            }
            b"VP8L" => {
                if data.len() < 5 || data[0] != 0x2f || bitstream.is_some() {
                    return Err("WebP VP8L payload header is invalid or duplicated".into());
                }
                let width = 1 + u32::from(data[1]) + ((u32::from(data[2]) & 0x3f) << 8);
                let height = 1
                    + (u32::from(data[2]) >> 6)
                    + (u32::from(data[3]) << 2)
                    + ((u32::from(data[4]) & 0x0f) << 10);
                bitstream = Some((width, height));
            }
            b"ANIM" | b"ANMF" => animated = true,
            _ => {}
        }
        offset = padded_end;
    }
    if offset != declared {
        return Err("WebP container has trailing partial chunk data".into());
    }
    if animated {
        return Err("animated WebP files are not allowed".into());
    }
    let (width, height) = bitstream.ok_or("WebP image payload is missing")?;
    if width == 0 || height == 0 {
        return Err("WebP image dimensions are invalid".into());
    }
    if canvas.is_some_and(|dimensions| dimensions != (width, height)) {
        return Err("WebP canvas and payload dimensions do not match".into());
    }
    Ok(WebpInfo {
        width,
        height,
        animated: false,
    })
}

fn validate_webp_bytes(
    bytes: Vec<u8>,
    expected: Option<(u32, u32)>,
    maximum: Option<(u32, u32)>,
) -> Result<(WebpInfo, Vec<u8>), String> {
    let inspected = inspect_webp(&bytes)?;
    let (width, height) = (inspected.width, inspected.height);
    if let Some((expected_width, expected_height)) = expected {
        if width != expected_width || height != expected_height {
            return Err(format!(
                "spritesheet must be {expected_width}x{expected_height}, got {width}x{height}"
            ));
        }
    }
    if let Some((maximum_width, maximum_height)) = maximum {
        if width > maximum_width || height > maximum_height {
            return Err(format!(
                "image must fit within {maximum_width}x{maximum_height}, got {width}x{height}"
            ));
        }
    }

    let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes.as_slice()))
        .map_err(|error| format!("WebP decode failed: {error}"))?;
    if decoder.dimensions() != (width, height) || decoder.is_animated() {
        return Err("WebP decoder metadata does not match the validated payload".into());
    }
    let decoded_size = decoder
        .output_buffer_size()
        .ok_or("decoded WebP dimensions overflow")?;
    decoder.set_memory_limit(
        decoded_size
            .checked_add(bytes.len())
            .ok_or("WebP decode memory limit overflow")?,
    );
    let mut decoded = vec![0; decoded_size];
    decoder
        .read_image(&mut decoded)
        .map_err(|error| format!("WebP pixel decode failed: {error}"))?;
    Ok((inspected, bytes))
}

#[cfg(test)]
fn validate_webp(
    path: &Path,
    max_bytes: u64,
    expected: Option<(u32, u32)>,
    maximum: Option<(u32, u32)>,
) -> Result<(WebpInfo, Vec<u8>), String> {
    validate_webp_bytes(read_limited(path, max_bytes)?, expected, maximum)
}

fn validate_cap_webp(
    dir: &Dir,
    path: &Path,
    max_bytes: u64,
    expected: Option<(u32, u32)>,
    maximum: Option<(u32, u32)>,
) -> Result<(WebpInfo, Vec<u8>), String> {
    validate_webp_bytes(read_cap_limited(dir, path, max_bytes)?, expected, maximum)
}

fn content_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hash = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(&mut hash, "{byte:02x}");
    }
    hash
}

fn cache_validated_asset(
    cache_root: &Path,
    cache_dir: &Dir,
    bytes: &[u8],
) -> Result<PathBuf, String> {
    let file_name = format!("{}.webp", content_hash(bytes));
    let path = cache_root.join(&file_name);
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    match cache_dir.open_with(&file_name, &options) {
        Ok(mut file) => {
            file.write_all(bytes).map_err(|error| {
                format!("could not write pet cache {}: {error}", path.display())
            })?;
            file.sync_all()
                .map_err(|error| format!("could not sync pet cache {}: {error}", path.display()))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let cached = read_cap_limited(cache_dir, Path::new(&file_name), MAX_SPRITESHEET_BYTES)?;
            if cached != bytes {
                return Err("pet cache content hash collision".into());
            }
        }
        Err(error) => {
            return Err(format!(
                "could not create pet cache {}: {error}",
                path.display()
            ));
        }
    }
    Ok(path)
}

fn parse_package(
    package_dir: &Dir,
    cache_root: &Path,
    cache_dir: &Dir,
    directory_id: &str,
) -> Result<Candidate, String> {
    if !is_valid_id(directory_id) {
        return Err("directory name must be a portable lowercase pet id".into());
    }
    let manifest_bytes = read_cap_limited(package_dir, Path::new("pet.json"), MAX_MANIFEST_BYTES)?;
    let manifest: PetManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("pet.json is invalid: {error}"))?;
    if manifest.schema_version.is_some_and(|version| version != 1) {
        return Err("unsupported pet.json schemaVersion".into());
    }
    if manifest.id != directory_id || !is_valid_id(&manifest.id) {
        return Err("pet.json id must match the package directory".into());
    }
    let display_name = manifest.display_name.trim();
    if display_name.is_empty() || display_name.chars().count() > 64 {
        return Err("displayName must contain 1 to 64 characters".into());
    }
    if manifest
        .description
        .as_ref()
        .is_some_and(|description| description.chars().count() > 240)
    {
        return Err("description must not exceed 240 characters".into());
    }
    if manifest.sprite_version_number != 2 {
        return Err("only spriteVersionNumber 2 packages are supported".into());
    }

    let (_, sprite_bytes) = validate_cap_webp(
        package_dir,
        Path::new("spritesheet.webp"),
        MAX_SPRITESHEET_BYTES,
        Some((V2_ATLAS_WIDTH, V2_ATLAS_HEIGHT)),
        None,
    )?;
    let sprite_path = cache_validated_asset(cache_root, cache_dir, &sprite_bytes)?;

    let thumbnail_path = match package_dir.symlink_metadata("thumbnail.webp") {
        Ok(_) => {
            let (info, thumbnail_bytes) = validate_cap_webp(
                package_dir,
                Path::new("thumbnail.webp"),
                MAX_THUMBNAIL_BYTES,
                None,
                Some((MAX_THUMBNAIL_DIMENSION, MAX_THUMBNAIL_DIMENSION)),
            )?;
            if info.width > MAX_THUMBNAIL_DIMENSION || info.height > MAX_THUMBNAIL_DIMENSION {
                return Err(format!(
                    "thumbnail must fit within {MAX_THUMBNAIL_DIMENSION}x{MAX_THUMBNAIL_DIMENSION}"
                ));
            }
            Some(
                cache_validated_asset(cache_root, cache_dir, &thumbnail_bytes)?
                    .to_string_lossy()
                    .into_owned(),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("could not inspect thumbnail.webp: {error}")),
    };

    Ok(Candidate {
        package_id: directory_id.to_string(),
        entry: PetCatalogEntry {
            id: manifest.id,
            display_name: display_name.to_string(),
            description: manifest.description,
            sprite_version_number: 2,
            sprite_path: sprite_path.to_string_lossy().into_owned(),
            thumbnail_path,
        },
    })
}

fn scan_pet_root_in_cache(
    root: &PetsRoot,
    cache_root: &Path,
    cache_dir: &Dir,
) -> Result<PetCatalogScan, String> {
    let mut directories = Vec::with_capacity(MAX_PACKAGES);
    for (index, entry) in root
        .dir
        .entries()
        .map_err(|error| format!("could not scan {}: {error}", root.path.display()))?
        .enumerate()
    {
        if index >= MAX_ROOT_ENTRIES {
            return Err(format!(
                "custom pet directory may contain at most {MAX_ROOT_ENTRIES} entries"
            ));
        }
        let entry =
            entry.map_err(|error| format!("could not read pet directory entry: {error}"))?;
        let kind = entry
            .file_type()
            .map_err(|error| format!("could not inspect pet directory entry: {error}"))?;
        if kind.is_dir() || kind.is_symlink() {
            if directories.len() >= MAX_PACKAGES {
                return Err(format!(
                    "custom pet directory may contain at most {MAX_PACKAGES} packages"
                ));
            }
            let file_name = entry.file_name();
            let package_id = file_name.to_string_lossy().into_owned();
            directories.push((file_name, package_id));
        }
    }
    directories.sort_by_key(|(_, package_id)| package_id.to_ascii_lowercase());

    let mut errors = Vec::new();
    let mut candidates = Vec::new();
    for (directory_name, package_id) in directories {
        let parsed = root
            .dir
            .open_dir_nofollow(&directory_name)
            .map_err(|error| format!("could not safely open package: {error}"))
            .and_then(|package_dir| {
                parse_package(&package_dir, cache_root, cache_dir, &package_id)
            });
        match parsed {
            Ok(candidate) => candidates.push(candidate),
            Err(message) => errors.push(PetCatalogError {
                package_id,
                message,
            }),
        }
    }

    let mut counts = HashMap::<String, usize>::new();
    for candidate in &candidates {
        *counts
            .entry(candidate.package_id.to_ascii_lowercase())
            .or_default() += 1;
    }
    let mut pets = Vec::new();
    for candidate in candidates {
        if counts
            .get(&candidate.package_id.to_ascii_lowercase())
            .copied()
            .unwrap_or_default()
            > 1
        {
            errors.push(PetCatalogError {
                package_id: candidate.package_id,
                message: "pet id conflicts with another package when compared case-insensitively"
                    .into(),
            });
        } else {
            pets.push(candidate.entry);
        }
    }
    pets.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    errors.sort_by(|left, right| left.package_id.cmp(&right.package_id));

    Ok(PetCatalogScan {
        root: root.path.to_string_lossy().into_owned(),
        pets,
        errors,
    })
}

#[cfg(test)]
fn scan_pet_root(root: &PetsRoot, cache_root: &Path) -> Result<PetCatalogScan, String> {
    let (cache_root, cache_dir) = prepare_cache_root(cache_root)?;
    scan_pet_root_in_cache(root, &cache_root, &cache_dir)
}

#[cfg(test)]
fn scan_pet_path(root: &Path, cache_root: &Path) -> Result<PetCatalogScan, String> {
    let parent = root.parent().ok_or("pet test root has no parent")?;
    let name = root.file_name().ok_or("pet test root has no name")?;
    let parent_dir = Dir::open_ambient_dir(parent, ambient_authority())
        .map_err(|error| format!("could not open pet test parent: {error}"))?;
    let dir = parent_dir
        .open_dir_nofollow(name)
        .map_err(|error| format!("could not safely open pet test root: {error}"))?;
    scan_pet_root(
        &PetsRoot {
            path: root.to_path_buf(),
            dir,
        },
        cache_root,
    )
}

fn pet_cache_session_id() -> &'static str {
    PET_CACHE_SESSION_ID.get_or_init(|| {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        format!("{}-{nonce:x}", std::process::id())
    })
}

fn best_effort_remove_cache_entry(path: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_symlink() || metadata.is_file() {
        let _ = std::fs::remove_file(path);
    } else if metadata.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    }
}

fn best_effort_prune_cache_children(parent: &Path, keep: &[PathBuf], limit: usize) {
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.take(limit).flatten() {
        let path = entry.path();
        if !keep.iter().any(|kept| kept == &path) {
            best_effort_remove_cache_entry(&path);
        }
    }
}

fn catalog_asset_paths(catalog: &PetCatalogScan) -> Vec<PathBuf> {
    let mut assets = Vec::with_capacity(catalog.pets.len() * 2);
    for pet in &catalog.pets {
        assets.push(PathBuf::from(&pet.sprite_path));
        if let Some(thumbnail) = &pet.thumbnail_path {
            assets.push(PathBuf::from(thumbnail));
        }
    }
    assets.sort();
    assets.dedup();
    assets
}

fn current_pet_cache_assets(session_root: &Path) -> Result<Vec<PathBuf>, String> {
    let state = PET_CACHE_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &state.allowed_root {
        Some(allowed) if allowed == session_root => Ok(state.current_assets.clone()),
        Some(_) => Err("pet cache root changed during this app session".into()),
        None => Ok(Vec::new()),
    }
}

fn activate_pet_cache(
    app: &tauri::AppHandle,
    cache_base: &Path,
    session_root: &Path,
    assets: &[PathBuf],
) -> Result<(), String> {
    let scope = app.asset_protocol_scope();
    let mut state = PET_CACHE_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &state.allowed_root {
        Some(allowed) if allowed == session_root => {}
        Some(_) => return Err("pet cache root changed during this app session".into()),
        None => {
            scope
                .allow_directory(session_root, true)
                .map_err(|error| format!("could not allow the pet cache directory: {error}"))?;
            state.allowed_root = Some(session_root.to_path_buf());
        }
    }
    let previous = std::mem::replace(&mut state.current_assets, assets.to_vec());
    drop(state);

    best_effort_prune_cache_children(
        cache_base,
        &[session_root.to_path_buf()],
        MAX_CACHE_SESSION_ENTRIES,
    );
    let mut keep = assets.to_vec();
    keep.extend(previous);
    keep.sort();
    keep.dedup();
    best_effort_prune_cache_children(session_root, &keep, MAX_CACHE_DIRECTORY_ENTRIES);
    Ok(())
}

#[tauri::command]
pub async fn pet_directory_prepare(app: tauri::AppHandle) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("home directory is unavailable: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        pets_root_from_home(&home).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("pet directory task failed: {error}"))?
}

#[tauri::command]
pub async fn pet_catalog_scan(app: tauri::AppHandle) -> Result<PetCatalogScan, String> {
    let permit = PetScanPermit::acquire()?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("home directory is unavailable: {error}"))?;
    let app_cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("pet cache directory is unavailable: {error}"))?;
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let root = open_pets_root_from_home(&home)?;
        let requested_session_root = app_cache.join("pet-assets-v2").join(pet_cache_session_id());
        let (session_root, session_dir) = prepare_cache_root(&requested_session_root)?;
        let cache_base = session_root
            .parent()
            .ok_or("pet cache session has no parent")?
            .to_path_buf();
        let current_assets = current_pet_cache_assets(&session_root)?;
        best_effort_prune_cache_children(
            &session_root,
            &current_assets,
            MAX_CACHE_DIRECTORY_ENTRIES,
        );
        let result = match scan_pet_root_in_cache(&root, &session_root, &session_dir) {
            Ok(result) => result,
            Err(error) => {
                best_effort_prune_cache_children(
                    &session_root,
                    &current_assets,
                    MAX_CACHE_DIRECTORY_ENTRIES,
                );
                return Err(error);
            }
        };
        let assets = catalog_asset_paths(&result);
        if let Err(error) = activate_pet_cache(&task_app, &cache_base, &session_root, &assets) {
            best_effort_prune_cache_children(
                &session_root,
                &current_assets,
                MAX_CACHE_DIRECTORY_ENTRIES,
            );
            return Err(error);
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("pet catalog scan task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicU64, atomic::Ordering, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn v2_webp() -> &'static [u8] {
        static WEBP: OnceLock<Vec<u8>> = OnceLock::new();
        WEBP.get_or_init(|| {
            let pixels = vec![0_u8; (V2_ATLAS_WIDTH * V2_ATLAS_HEIGHT * 4) as usize];
            let mut bytes = Vec::new();
            image_webp::WebPEncoder::new(&mut bytes)
                .encode(
                    &pixels,
                    V2_ATLAS_WIDTH,
                    V2_ATLAS_HEIGHT,
                    image_webp::ColorType::Rgba8,
                )
                .unwrap();
            bytes
        })
    }

    fn mismatched_vp8x() -> Vec<u8> {
        fn push_chunk(target: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
            target.extend_from_slice(kind);
            target.extend_from_slice(&(data.len() as u32).to_le_bytes());
            target.extend_from_slice(data);
            if data.len() % 2 == 1 {
                target.push(0);
            }
        }

        let mut vp8x = vec![0_u8; 10];
        vp8x[4..7].copy_from_slice(&(V2_ATLAS_WIDTH - 1).to_le_bytes()[..3]);
        vp8x[7..10].copy_from_slice(&(V2_ATLAS_HEIGHT - 1).to_le_bytes()[..3]);
        let mut vp8 = vec![0_u8; 10];
        vp8[3..6].copy_from_slice(&[0x9d, 0x01, 0x2a]);
        vp8[6..8].copy_from_slice(&0x3fff_u16.to_le_bytes());
        vp8[8..10].copy_from_slice(&0x3fff_u16.to_le_bytes());

        let mut body = b"WEBP".to_vec();
        push_chunk(&mut body, b"VP8X", &vp8x);
        push_chunk(&mut body, b"VP8 ", &vp8);
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&body);
        bytes
    }

    fn temp_root() -> PathBuf {
        static NONCE: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = NONCE.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "jupiter-pets-test-{}-{nonce}-{sequence}",
            std::process::id()
        ))
    }

    #[test]
    fn fully_decodes_webp_and_rejects_truncated_payloads() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("spritesheet.webp");
        std::fs::write(&path, v2_webp()).unwrap();
        assert_eq!(
            validate_webp(
                &path,
                MAX_SPRITESHEET_BYTES,
                Some((V2_ATLAS_WIDTH, V2_ATLAS_HEIGHT)),
                None,
            )
            .unwrap()
            .0,
            WebpInfo {
                width: V2_ATLAS_WIDTH,
                height: V2_ATLAS_HEIGHT,
                animated: false,
            }
        );
        std::fs::write(&path, &v2_webp()[..v2_webp().len() / 2]).unwrap();
        assert!(validate_webp(
            &path,
            MAX_SPRITESHEET_BYTES,
            Some((V2_ATLAS_WIDTH, V2_ATLAS_HEIGHT)),
            None,
        )
        .is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_mismatched_inner_dimensions_before_pixel_decode() {
        let root = temp_root();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("spritesheet.webp");
        std::fs::write(&path, mismatched_vp8x()).unwrap();
        let error = validate_webp(
            &path,
            MAX_SPRITESHEET_BYTES,
            Some((V2_ATLAS_WIDTH, V2_ATLAS_HEIGHT)),
            None,
        )
        .unwrap_err();
        assert!(error.contains("canvas and payload dimensions do not match"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn validates_portable_ids() {
        assert!(is_valid_id("paper-fox.v2"));
        assert!(!is_valid_id("PaperFox"));
        assert!(!is_valid_id("../fox"));
        assert!(!is_valid_id("paper-fox."));
        assert!(!is_valid_id("con"));
    }

    #[test]
    fn rejects_a_second_scan_before_it_reaches_the_blocking_pool() {
        PET_SCAN_ACTIVE.store(false, Ordering::Release);
        let first = PetScanPermit::acquire().unwrap();
        assert!(PetScanPermit::acquire().is_err());
        drop(first);
        assert!(PetScanPermit::acquire().is_ok());
    }

    #[test]
    fn scans_valid_packages_and_isolates_broken_ones() {
        let root = temp_root();
        let cache = temp_root().with_extension("cache");
        let valid = root.join("test-pet");
        let broken = root.join("broken-pet");
        std::fs::create_dir_all(&valid).unwrap();
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(
            valid.join("pet.json"),
            br#"{"id":"test-pet","displayName":"Test Pet","spriteVersionNumber":2}"#,
        )
        .unwrap();
        std::fs::write(valid.join("spritesheet.webp"), v2_webp()).unwrap();
        std::fs::write(broken.join("pet.json"), b"not-json").unwrap();

        let result = scan_pet_path(&root, &cache).unwrap();
        assert_eq!(result.pets.len(), 1);
        assert_eq!(result.pets[0].id, "test-pet");
        assert!(Path::new(&result.pets[0].sprite_path).starts_with(cache.canonicalize().unwrap()));
        assert_eq!(result.errors.len(), 1);
        assert_eq!(result.errors[0].package_id, "broken-pet");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[test]
    fn reuses_content_addressed_assets_across_refreshes() {
        let root = temp_root();
        let cache = temp_root().with_extension("cache");
        let package = root.join("stable-pet");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("pet.json"),
            br#"{"id":"stable-pet","displayName":"Stable","spriteVersionNumber":2}"#,
        )
        .unwrap();
        std::fs::write(package.join("spritesheet.webp"), v2_webp()).unwrap();

        let first = scan_pet_path(&root, &cache).unwrap();
        let first_path = first.pets[0].sprite_path.clone();
        let first_count = std::fs::read_dir(&cache).unwrap().count();
        let second = scan_pet_path(&root, &cache).unwrap();

        assert_eq!(second.pets[0].sprite_path, first_path);
        assert_eq!(std::fs::read_dir(&cache).unwrap().count(), first_count);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_packages() {
        use std::os::unix::fs::symlink;
        let root = temp_root();
        let cache = temp_root().with_extension("cache");
        let outside = temp_root().with_extension("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("linked-pet")).unwrap();
        let result = scan_pet_path(&root, &cache).unwrap();
        assert!(result.pets.is_empty());
        assert_eq!(result.errors.len(), 1);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_package_files() {
        use std::os::unix::fs::symlink;
        let root = temp_root();
        let cache = temp_root().with_extension("cache");
        let outside = temp_root().with_extension("outside.webp");
        let package = root.join("linked-file-pet");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("pet.json"),
            br#"{"id":"linked-file-pet","displayName":"Linked","spriteVersionNumber":2}"#,
        )
        .unwrap();
        std::fs::write(&outside, v2_webp()).unwrap();
        symlink(&outside, package.join("spritesheet.webp")).unwrap();
        let result = scan_pet_path(&root, &cache).unwrap();
        assert!(result.pets.is_empty());
        assert_eq!(result.errors.len(), 1);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_file(outside);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_scanning_the_open_root_when_its_path_is_replaced() {
        use std::os::unix::fs::symlink;
        let root = temp_root();
        let detached = root.with_extension("detached");
        let outside = temp_root().with_extension("outside");
        let cache = temp_root().with_extension("cache");
        let package = root.join("stable-pet");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(
            package.join("pet.json"),
            br#"{"id":"stable-pet","displayName":"Stable","spriteVersionNumber":2}"#,
        )
        .unwrap();
        std::fs::write(package.join("spritesheet.webp"), v2_webp()).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let parent = root.parent().unwrap();
        let parent_dir = Dir::open_ambient_dir(parent, ambient_authority()).unwrap();
        let dir = parent_dir
            .open_dir_nofollow(root.file_name().unwrap())
            .unwrap();
        std::fs::rename(&root, &detached).unwrap();
        symlink(&outside, &root).unwrap();

        let result = scan_pet_root(
            &PetsRoot {
                path: root.clone(),
                dir,
            },
            &cache,
        )
        .unwrap();
        assert_eq!(result.pets.len(), 1);
        assert_eq!(result.pets[0].id, "stable-pet");

        let _ = std::fs::remove_file(root);
        let _ = std::fs::remove_dir_all(detached);
        let _ = std::fs::remove_dir_all(outside);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_jupiter_directory() {
        use std::os::unix::fs::symlink;
        let home = temp_root();
        let outside = temp_root().with_extension("outside");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, home.join(".jupiter")).unwrap();
        assert!(pets_root_from_home(&home).is_err());
        let _ = std::fs::remove_dir_all(home);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn bounds_package_directory_enumeration() {
        let root = temp_root();
        let cache = temp_root().with_extension("cache");
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..=MAX_PACKAGES {
            std::fs::create_dir(root.join(format!("pet-{index:02}"))).unwrap();
        }
        let error = scan_pet_path(&root, &cache).unwrap_err();
        assert!(error.contains("at most 64 packages"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(cache);
    }

    #[test]
    fn cache_cleanup_keeps_the_current_and_previous_asset_sets() {
        let session = temp_root().with_extension("session");
        std::fs::create_dir_all(&session).unwrap();
        let old = session.join("old.webp");
        let previous = session.join("previous.webp");
        let current = session.join("current.webp");
        for asset in [&old, &previous, &current] {
            std::fs::write(asset, b"cached").unwrap();
        }

        best_effort_prune_cache_children(
            &session,
            &[previous.clone(), current.clone()],
            MAX_CACHE_DIRECTORY_ENTRIES,
        );

        assert!(!old.exists());
        assert!(previous.exists());
        assert!(current.exists());
        let _ = std::fs::remove_dir_all(session);
    }

    #[cfg(unix)]
    #[test]
    fn cache_root_canonicalizes_the_directory_used_for_asset_scope() {
        use std::os::unix::fs::symlink;
        let actual = temp_root().with_extension("actual-cache");
        let alias = temp_root().with_extension("cache-alias");
        std::fs::create_dir_all(&actual).unwrap();
        symlink(&actual, &alias).unwrap();

        let requested = alias.join("pet-assets-v2").join("session");
        let (canonical, _) = prepare_cache_root(&requested).unwrap();

        assert_eq!(
            canonical,
            actual.join("pet-assets-v2/session").canonicalize().unwrap()
        );
        let _ = std::fs::remove_file(alias);
        let _ = std::fs::remove_dir_all(actual);
    }
}
