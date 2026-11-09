// Copyright 2026 Nowledge
// SPDX-License-Identifier: Apache-2.0

use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::num::NonZeroUsize;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use hawdb::{
    value::{Value, ValueRef},
    Database, DatabaseConfig, HawDBError,
};
use napi::bindgen_prelude::{AsyncTask, ClassInstance, JavaScriptClassExt, PromiseRaw};
use napi::{Env, Error, ScopedTask, Status, Task};
use napi_derive::napi;

const REVISION: &str = "d47dd9b2b6a51c57a8a621367f5ff6d5d958b3e6";
const ABI: &str = "concord-hawdb-1";
const LOCK: &str = "owner.hawdb.lock";
const IDENTITY: &str = "concord.identity";
const CREATE_ENTRIES: &str = "CREATE TABLE concord_cache_entries (namespace TEXT NOT NULL, cache_key TEXT NOT NULL, payload BYTEA NOT NULL, sequence BIGINT NOT NULL, PRIMARY KEY (namespace, cache_key))";
const CREATE_SCHEMA: &str = "CREATE TABLE concord_cache_schema (version TEXT NOT NULL PRIMARY KEY)";
const INSERT_SCHEMA: &str = "INSERT INTO concord_cache_schema (version) VALUES ($1)";
const SELECT_SCHEMA: &str = "SELECT version FROM concord_cache_schema LIMIT 2";
const SELECT_NS: &str = "SELECT cache_key, payload, sequence FROM concord_cache_entries WHERE namespace = $1 ORDER BY sequence LIMIT 20001";
const SELECT_ONE: &str =
    "SELECT payload FROM concord_cache_entries WHERE namespace = $1 AND cache_key = $2 LIMIT 1";
const DELETE_ONE: &str =
    "DELETE FROM concord_cache_entries WHERE namespace = $1 AND cache_key = $2";
const INSERT_ONE: &str = "INSERT INTO concord_cache_entries (namespace, cache_key, payload, sequence) VALUES ($1, $2, $3, $4)";
const DELETE_NS: &str = "DELETE FROM concord_cache_entries WHERE namespace = $1";
const MIB: usize = 1024 * 1024;

fn err(code: &'static str, reason: impl std::fmt::Display) -> Error {
    Error::new(Status::GenericFailure, format!("{code}: {reason}"))
}
fn unavailable(reason: impl std::fmt::Display) -> Error {
    err("HawdbUnavailable", reason)
}
fn limit(reason: impl std::fmt::Display) -> Error {
    err("HawdbLimit", reason)
}
fn unsafe_path(reason: impl std::fmt::Display) -> Error {
    err("UnsafePath", reason)
}
fn engine_busy(error: &HawDBError) -> bool {
    matches!(error, HawDBError::BranchBusy { .. })
        || error
            .to_string()
            .contains("database directory is already open")
}
fn engine_open_error(error: HawDBError) -> Error {
    let message = error.to_string();
    if engine_busy(&error) {
        err("HawdbBusy", message)
    } else {
        unavailable(message)
    }
}

#[napi(object)]
pub struct CacheEntry {
    pub key: String,
    pub payload: String,
}
#[napi(object)]
pub struct Quota {
    pub max_entries: u32,
    pub max_bytes: u32,
}
#[napi(object)]
pub struct NativeIdentity {
    pub revision: String,
    pub abi: String,
}
#[napi(object)]
pub struct ReclamationReport {
    pub reclaimed_objects: f64,
    pub reclaimed_bytes: f64,
    pub deferred_for_active_leases: bool,
}
#[napi]
pub fn native_identity() -> NativeIdentity {
    NativeIdentity {
        revision: REVISION.into(),
        abi: ABI.into(),
    }
}

#[derive(Clone)]
struct Row {
    namespace: String,
    key: String,
    payload: String,
    sequence: i64,
}
impl Row {
    fn bytes(&self) -> usize {
        self.namespace.len() + self.key.len() + self.payload.len()
    }
}
fn namespace_quota(namespace: &str, memory: bool) -> napi::Result<(usize, usize)> {
    match (memory, namespace) {
        (true, "document_parse") | (true, "code_parse") => Ok((10_000, 16 * MIB)),
        (true, "git_baseline") => Ok((128, 4 * MIB)),
        (false, "annotation_cache") => Ok((64, 24 * MIB)),
        (false, "code_cache") => Ok((20_000, 32 * MIB)),
        (false, "config_cache") => Ok((128, 8 * MIB)),
        (false, "feedback_cache") => Ok((10_000, 32 * MIB)),
        (false, "query_cache") => Ok((64, 16 * MIB)),
        (false, "workspace_projection") => Ok((1, 8 * MIB)),
        _ => Err(err(
            "HawdbIncompatible",
            "namespace is unavailable in this database mode",
        )),
    }
}
fn namespaces(memory: bool) -> &'static [&'static str] {
    if memory {
        &["document_parse", "code_parse", "git_baseline"]
    } else {
        &[
            "annotation_cache",
            "code_cache",
            "config_cache",
            "feedback_cache",
            "query_cache",
            "workspace_projection",
        ]
    }
}
fn config(read_only: bool) -> DatabaseConfig {
    DatabaseConfig {
        read_only,
        recovery_mode: hawdb::RecoveryMode::Strict,
        max_read_result_rows: Some(20_000),
        max_read_result_payload_bytes: Some(64 * MIB),
        max_wal_replay_entries: Some(100_000),
        max_wal_replay_bytes: Some(128 * MIB as u64),
        max_wal_quarantine_bytes: (128 * MIB) as u64,
        max_wal_record_bytes: Some(64 * MIB),
        max_wal_batch_operations: Some(50_000),
        max_checkpoint_encoded_bytes: Some(256 * MIB as u64),
        max_checkpoint_decoded_bytes: Some(512 * MIB as u64),
        segment_cache_capacity_bytes: (16 * MIB) as u64,
        max_graph_manifest_open_bytes: (8 * MIB) as u64,
        max_out_of_core_delta_bytes: Some((16 * MIB) as u64),
        max_relational_index_read_bytes: NonZeroUsize::new(16 * MIB).unwrap(),
        max_relational_hydration_bytes: NonZeroUsize::new(64 * MIB).unwrap(),
        ..DatabaseConfig::default()
    }
}
fn inspect_path(path: &Path, create: bool) -> napi::Result<bool> {
    if !path.is_absolute() {
        return Err(unsafe_path("database path must be absolute"));
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(part) => {
                current.push(part);
                match fs::symlink_metadata(&current) {
                    Ok(metadata) if metadata.file_type().is_symlink() => {
                        return Err(unsafe_path("symlink path component"))
                    }
                    Ok(metadata) if current == path && !metadata.is_dir() => {
                        return Err(unsafe_path("database root is not a directory"))
                    }
                    Ok(metadata) if current != path && !metadata.is_dir() => {
                        return Err(unsafe_path("parent is not a directory"))
                    }
                    Ok(_) => (),
                    Err(error) if error.kind() == io::ErrorKind::NotFound && current == path => {
                        if create {
                            fs::create_dir(&current).map_err(unsafe_path)?;
                            return Ok(true);
                        }
                        return Err(unavailable("database directory is absent"));
                    }
                    Err(error) => return Err(unsafe_path(error)),
                }
            }
            _ => return Err(unsafe_path("noncanonical path component")),
        }
    }
    Ok(false)
}
fn is_lock(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().ends_with(".lock"))
}
fn inspect_tree(path: &Path, require_owners: bool) -> napi::Result<Vec<PathBuf>> {
    let mut pending = vec![path.to_owned()];
    let mut inodes: BTreeMap<(u64, u64), (u64, u64)> = BTreeMap::new();
    let mut locks = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(unsafe_path)? {
            let entry = entry.map_err(unsafe_path)?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(unsafe_path)?;
            if metadata.file_type().is_symlink() {
                return Err(unsafe_path("symlink in database directory"));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                let group = inodes
                    .entry((metadata.dev(), metadata.ino()))
                    .or_insert((metadata.nlink(), 0));
                if group.0 != metadata.nlink() {
                    return Err(unsafe_path("hard link count changed during inspection"));
                }
                group.1 += 1;
                if is_lock(&entry.path()) {
                    if metadata.nlink() != 1 {
                        return Err(unsafe_path("ownership lock must have one link"));
                    }
                    locks.push(entry.path());
                }
                if require_owners && entry.file_name() == "branch.head" {
                    inspect_lock(&dir, false)?;
                }
            } else {
                return Err(unsafe_path("special file in database directory"));
            }
        }
    }
    if inodes.values().any(|(links, paths)| links != paths) {
        return Err(unsafe_path("hard link outside database directory"));
    }
    locks.sort();
    Ok(locks)
}
fn inspect_lock(path: &Path, create: bool) -> napi::Result<Option<File>> {
    open_lock_file(&path.join(LOCK), create).map(Some)
}
// Shared lock admission preserves the OS failure class; callers map it to their
// own domain errors. Only try_lock's WouldBlock means a competing owner.
struct LockFailure {
    code: &'static str,
    message: String,
}
impl LockFailure {
    fn new(code: &'static str, message: impl std::fmt::Display) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
    fn io(error: io::Error) -> Self {
        Self::new(
            if error.kind() == io::ErrorKind::PermissionDenied {
                "Permission"
            } else {
                "Io"
            },
            error,
        )
    }
    fn hawdb(self) -> Error {
        err(
            match self.code {
                "Busy" => "HawdbBusy",
                "Io" => "HawdbUnavailable",
                _ => "UnsafePath",
            },
            self.message,
        )
    }
    fn server(self) -> Error {
        Error::new(
            Status::GenericFailure,
            format!("ServerLock{}: {}", self.code, self.message),
        )
    }
}
fn checked_lock_file(lock_path: &Path, create: bool) -> Result<File, LockFailure> {
    match fs::symlink_metadata(lock_path) {
        Ok(metadata) if !metadata.is_file() || metadata.nlink() != 1 => {
            return Err(LockFailure::new(
                "Type",
                "lock must be a single-link regular file",
            ))
        }
        Ok(_) => (),
        Err(error) if error.kind() == io::ErrorKind::NotFound && create => (),
        Err(error) => return Err(LockFailure::io(error)),
    }
    let file = OpenOptions::new()
        .read(true)
        .write(create)
        .create(create)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(lock_path)
        .map_err(LockFailure::io)?;
    checked_lock_identity(&file, lock_path)?;
    Ok(file)
}
fn checked_lock_identity(file: &File, lock_path: &Path) -> Result<(), LockFailure> {
    let opened = file.metadata().map_err(LockFailure::io)?;
    let linked = fs::symlink_metadata(lock_path).map_err(LockFailure::io)?;
    if !opened.is_file() || !linked.is_file() || opened.nlink() != 1 || linked.nlink() != 1 {
        return Err(LockFailure::new(
            "Type",
            "lock must be a single-link regular file",
        ));
    }
    if opened.dev() != linked.dev() || opened.ino() != linked.ino() {
        return Err(LockFailure::new("Identity", "lock device/inode changed"));
    }
    Ok(())
}
fn try_lock_file(file: &File) -> Result<(), LockFailure> {
    match file.try_lock() {
        Ok(()) => Ok(()),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err(LockFailure::new("Busy", "lock is held by another handle"))
        }
        Err(std::fs::TryLockError::Error(error)) => Err(LockFailure::io(error)),
    }
}
fn open_lock_file(path: &Path, create: bool) -> napi::Result<File> {
    checked_lock_file(path, create).map_err(LockFailure::hawdb)
}
fn verify_lock_file(file: &File, path: &Path) -> napi::Result<()> {
    checked_lock_identity(file, path).map_err(LockFailure::hawdb)
}
fn lock_file(file: &File) -> napi::Result<()> {
    try_lock_file(file).map_err(LockFailure::hawdb)
}

fn server_directory(path: &Path) -> Result<(u64, u64), LockFailure> {
    if !path.is_absolute() {
        return Err(LockFailure::new(
            "Type",
            "server directory must be absolute",
        ));
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => current.push(component.as_os_str()),
            Component::Normal(part) => {
                current.push(part);
                let metadata = fs::symlink_metadata(&current).map_err(LockFailure::io)?;
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(LockFailure::new(
                        "Type",
                        "server directory contains a non-directory or symlink",
                    ));
                }
            }
            _ => {
                return Err(LockFailure::new(
                    "Type",
                    "server directory must be canonical",
                ))
            }
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(LockFailure::io)?;
    Ok((metadata.dev(), metadata.ino()))
}
#[napi(object)]
pub struct ServerLockIdentity {
    pub device: String,
    pub inode: String,
}
/// Owns only <server_directory>/lock. Closing never unlinks the lock file.
#[napi]
pub struct ServerLock {
    file: Option<File>,
    path: PathBuf,
    directory: PathBuf,
    identity: (u64, u64),
}
#[napi]
impl ServerLock {
    #[napi(constructor)]
    pub fn new(directory: String) -> napi::Result<Self> {
        let directory = PathBuf::from(directory);
        let identity = server_directory(&directory).map_err(LockFailure::server)?;
        let path = directory.join("lock");
        let file = checked_lock_file(&path, true).map_err(LockFailure::server)?;
        try_lock_file(&file).map_err(LockFailure::server)?;
        let lock = Self {
            file: Some(file),
            path,
            directory,
            identity,
        };
        lock.verify()?;
        Ok(lock)
    }
    #[napi]
    pub fn verify(&self) -> napi::Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| err("ServerLockClosed", "service lock is closed"))?;
        if server_directory(&self.directory).map_err(LockFailure::server)? != self.identity {
            return Err(err(
                "ServerLockIdentity",
                "server directory device/inode changed",
            ));
        }
        // A deleted inode has nlink=0; identity failure takes precedence here.
        let opened = file.metadata().map_err(|e| LockFailure::io(e).server())?;
        let linked = fs::symlink_metadata(&self.path).map_err(|e| LockFailure::io(e).server())?;
        if (opened.dev(), opened.ino()) != (linked.dev(), linked.ino()) {
            return Err(err(
                "ServerLockIdentity",
                "service lock device/inode changed",
            ));
        }
        checked_lock_identity(file, &self.path).map_err(LockFailure::server)
    }
    #[napi]
    pub fn identity(&self) -> napi::Result<ServerLockIdentity> {
        self.verify()?;
        let metadata = self
            .file
            .as_ref()
            .unwrap()
            .metadata()
            .map_err(|e| LockFailure::io(e).server())?;
        Ok(ServerLockIdentity {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
        })
    }
    #[napi]
    pub fn close(&mut self) {
        self.file = None;
    }
}
struct ConcordLease {
    file: File,
    path: PathBuf,
    root: PathBuf,
    identity: (u64, u64),
}
impl ConcordLease {
    fn acquire(root: &Path) -> napi::Result<Self> {
        let mut name = root.as_os_str().to_owned();
        name.push(".concord.lock");
        let path = PathBuf::from(name);
        let file = open_lock_file(&path, true)?;
        lock_file(&file)?;
        let stat = fs::symlink_metadata(root).map_err(unsafe_path)?;
        let lease = Self {
            file,
            path,
            root: root.to_owned(),
            identity: (stat.dev(), stat.ino()),
        };
        lease.verify()?;
        Ok(lease)
    }
    fn verify(&self) -> napi::Result<()> {
        inspect_path(&self.root, false)?;
        let root = fs::symlink_metadata(&self.root).map_err(unsafe_path)?;
        if (root.dev(), root.ino()) != self.identity {
            return Err(unsafe_path("database root inode changed"));
        }
        verify_lock_file(&self.file, &self.path)
    }
}
fn read_rows(db: &Database, namespace: &str) -> napi::Result<Vec<Row>> {
    let output = db
        .begin_read_transaction()
        .map_err(engine_open_error)?
        .query_sql_with_params_bounded(SELECT_NS, &[Value::String(namespace.into())], Some(20_001))
        .map_err(unavailable)?;
    if output.rows.len() > 20_000 {
        return Err(limit("query row budget exceeded"));
    }
    let mut result = Vec::with_capacity(output.rows.len());
    let memory = matches!(namespace, "document_parse" | "code_parse" | "git_baseline");
    let (entry_limit, byte_limit) = namespace_quota(namespace, memory)?;
    if output.rows.len() > entry_limit {
        return Err(limit("namespace entry budget exceeded"));
    }
    let mut bytes = 0_usize;
    for row in output.rows.iter() {
        let key = match row.get("cache_key") {
            Some(Value::String(value)) => value.to_owned(),
            _ => return Err(err("HawdbIncompatible", "invalid key column")),
        };
        let payload = match row.get("payload") {
            Some(Value::Binary(value)) => String::from_utf8(value.to_vec())
                .map_err(|_| err("HawdbIncompatible", "invalid UTF-8 payload"))?,
            _ => return Err(err("HawdbIncompatible", "invalid payload column")),
        };
        let sequence = match row.get("sequence") {
            Some(Value::Int(value)) => *value,
            _ => return Err(err("HawdbIncompatible", "invalid sequence column")),
        };
        let item = Row {
            namespace: namespace.into(),
            key,
            payload,
            sequence,
        };
        bytes = bytes.saturating_add(item.bytes());
        if bytes > byte_limit || bytes > 64 * MIB {
            return Err(limit("namespace byte budget exceeded"));
        }
        result.push(item);
    }
    Ok(result)
}
fn all_rows(db: &Database, memory: bool) -> napi::Result<Vec<Row>> {
    let mut rows = Vec::new();
    for namespace in namespaces(memory) {
        rows.extend(read_rows(db, namespace)?);
    }
    Ok(rows)
}
// Admission is bound to the pinned engine's current directory protocol.
// Refuse before opening the engine, whose writable open can otherwise convert a directory.
fn admit_manifest(path: &Path) -> napi::Result<()> {
    let expected_identity = cache_identity();
    let mut identity = Vec::new();
    File::open(path.join(IDENTITY))
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                err("HawdbIncompatible", "cache identity is unavailable")
            } else {
                unavailable(error)
            }
        })?
        .take(expected_identity.len() as u64 + 1)
        .read_to_end(&mut identity)
        .map_err(unavailable)?;
    if identity != expected_identity.as_bytes() {
        return Err(err("HawdbIncompatible", "cache identity differs"));
    }
    let mut file = File::open(path.join("manifest.hawdb")).map_err(unavailable)?;
    let expected = b"HAWDB_BRANCH_PROJECT_V2\n";
    let mut prefix = [0_u8; 24];
    let count = file.read(&mut prefix).map_err(unavailable)?;
    if count < expected.len() || &prefix[..expected.len()] != expected {
        return Err(err(
            "HawdbIncompatible",
            "cache directory format is unavailable",
        ));
    }
    Ok(())
}
fn cache_identity() -> String {
    format!("{REVISION}/{ABI}/1")
}
fn schema(db: &Database) -> napi::Result<()> {
    let output = db
        .begin_read_transaction()
        .map_err(engine_open_error)?
        .query_sql_with_params_bounded(SELECT_SCHEMA, &[], Some(2))
        .map_err(|error| {
            if engine_busy(&error) {
                engine_open_error(error)
            } else {
                err("HawdbIncompatible", error)
            }
        })?;
    if output.rows.len() != 1 {
        return Err(err("HawdbIncompatible", "cache schema version missing"));
    }
    match output.rows.get(0, "version") {
        Some(ValueRef::String(value)) if value == cache_identity() => (),
        _ => return Err(err("HawdbIncompatible", "unsupported cache schema")),
    }
    read_rows(db, namespaces(false)[0])
        .map(|_| ())
        .or_else(|_| read_rows(db, namespaces(true)[0]).map(|_| ()))
        .map_err(|_| err("HawdbIncompatible", "cache entry table missing"))
}
fn initialize(db: &mut Database) -> napi::Result<()> {
    db.query_sql(CREATE_ENTRIES).map_err(unavailable)?;
    db.query_sql(CREATE_SCHEMA).map_err(unavailable)?;
    db.query_sql_with_params(INSERT_SCHEMA, &[Value::String(cache_identity())])
        .map_err(unavailable)?;
    Ok(())
}

struct Handle {
    db: Option<Database>,
    lease: Option<ConcordLease>,
    path: Option<PathBuf>,
    memory: bool,
    read_only: bool,
    writes: usize,
    churn: usize,
    poisoned: bool,
    closing: bool,
}
#[napi]
pub struct CacheBridge {
    handle: Arc<Mutex<Handle>>,
}
#[napi]
impl CacheBridge {
    #[napi(constructor)]
    pub fn new(path: String, read_only: bool, create: bool) -> napi::Result<Self> {
        if read_only && create {
            return Err(err("HawdbIncompatible", "read-only create is invalid"));
        }
        let path = Path::new(&path);
        let new_dir = inspect_path(path, create)?;
        let lease = ConcordLease::acquire(path)?;
        inspect_tree(path, read_only)?;
        let manifest_exists = path.join("manifest.hawdb").is_file();
        let lock_exists = path.join(LOCK).exists();
        if !manifest_exists && (read_only || !create || !new_dir && !is_owner_only(path)?) {
            return Err(err("HawdbIncompatible", "existing database is incomplete"));
        }
        if !manifest_exists && lock_exists && read_only {
            return Err(unavailable("database manifest is absent"));
        }
        if manifest_exists {
            admit_manifest(path)?;
        }
        inspect_lock(path, !read_only)?;
        let mut db =
            Database::open_with_config(path, config(read_only)).map_err(engine_open_error)?;
        if manifest_exists {
            schema(&db)?;
        } else {
            initialize(&mut db)?;
            db.checkpoint().map_err(unavailable)?;
            fs::write(path.join(IDENTITY), cache_identity()).map_err(unavailable)?;
        }
        lease.verify()?;
        Ok(Self {
            handle: Arc::new(Mutex::new(Handle {
                db: Some(db),
                lease: Some(lease),
                path: Some(path.to_owned()),
                memory: false,
                read_only,
                writes: 0,
                churn: 0,
                poisoned: false,
                closing: false,
            })),
        })
    }
    #[napi(factory)]
    pub fn memory() -> napi::Result<Self> {
        let mut db = Database::new_with_config(config(false));
        initialize(&mut db)?;
        Ok(Self {
            handle: Arc::new(Mutex::new(Handle {
                db: Some(db),
                lease: None,
                path: None,
                memory: true,
                read_only: false,
                writes: 0,
                churn: 0,
                poisoned: false,
                closing: false,
            })),
        })
    }
    #[napi]
    pub fn get(&self, namespace: String, keys: Vec<String>) -> napi::Result<Vec<CacheEntry>> {
        let handle = self.ready()?;
        namespace_quota(&namespace, handle.memory)?;
        if keys.len() > 1000 {
            return Err(limit("get key batch exceeds 1000"));
        }
        let db = active(&handle)?;
        let mut result = Vec::new();
        let mut bytes = 0_usize;
        for key in keys {
            if key.is_empty() || key.len() > 8 * MIB {
                return Err(limit("invalid key length"));
            }
            let output = db
                .begin_read_transaction()
                .map_err(engine_open_error)?
                .query_sql_with_params_bounded(
                    SELECT_ONE,
                    &[Value::String(namespace.clone()), Value::String(key.clone())],
                    Some(1),
                )
                .map_err(unavailable)?;
            if let Some(value) = output.rows.get(0, "payload") {
                let payload = match value {
                    ValueRef::Binary(value) => String::from_utf8(value.to_vec())
                        .map_err(|_| err("HawdbIncompatible", "invalid UTF-8 payload"))?,
                    _ => return Err(err("HawdbIncompatible", "invalid payload column")),
                };
                bytes += payload.len();
                if bytes > 64 * MIB {
                    return Err(limit("get payload budget exceeded"));
                }
                result.push(CacheEntry { key, payload });
            }
        }
        Ok(result)
    }
    #[napi]
    pub fn scan(&self, namespace: String) -> napi::Result<Vec<CacheEntry>> {
        let handle = self.ready()?;
        namespace_quota(&namespace, handle.memory)?;
        let rows = read_rows(active(&handle)?, &namespace)?;
        Ok(rows
            .into_iter()
            .map(|row| CacheEntry {
                key: row.key,
                payload: row.payload,
            })
            .collect())
    }
    #[napi]
    pub fn put(
        &self,
        namespace: String,
        entries: Vec<CacheEntry>,
        quota: Option<Quota>,
    ) -> napi::Result<()> {
        let mut handle = self.ready()?;
        let (max_entries, max_bytes) = namespace_quota(&namespace, handle.memory)?;
        if handle.read_only {
            return Err(err("HawdbIncompatible", "database is read-only"));
        }
        if entries.len() > 1000 {
            return Err(limit("write batch exceeds 1000"));
        }
        let mut input_bytes = 0_usize;
        let mut incoming = BTreeMap::new();
        for (position, entry) in entries.into_iter().enumerate() {
            if entry.key.is_empty() {
                return Err(limit("empty key"));
            }
            let size = namespace.len() + entry.key.len() + entry.payload.len();
            if size > 8 * MIB {
                return Err(limit("entry exceeds 8 MiB"));
            }
            input_bytes = input_bytes.saturating_add(size);
            incoming.insert(entry.key.clone(), (position, entry));
        }
        if input_bytes > 16 * MIB {
            return Err(limit("batch exceeds 16 MiB"));
        }
        let max_entries = quota.as_ref().map_or(max_entries, |value| {
            max_entries.min(value.max_entries as usize)
        });
        let max_bytes = quota
            .as_ref()
            .map_or(max_bytes, |value| max_bytes.min(value.max_bytes as usize));
        if max_entries == 0 || max_bytes == 0 {
            return Err(limit("quota must be positive"));
        }
        let new_bytes: usize = incoming
            .values()
            .map(|(_, value)| namespace.len() + value.key.len() + value.payload.len())
            .sum();
        if incoming.len() > max_entries || new_bytes > max_bytes {
            return Err(limit("incoming batch exceeds namespace budget"));
        }
        if incoming.is_empty() {
            return Ok(());
        }
        let memory = handle.memory;
        let db = active_mut(&mut handle)?;
        let mut old = all_rows(db, memory)?;
        let next = old
            .iter()
            .map(|row| row.sequence)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| limit("sequence exhausted"))?;
        let mut deletes: HashSet<String> = incoming.keys().cloned().collect();
        let mut remaining: Vec<Row> = old
            .drain(..)
            .filter(|row| row.namespace == namespace && !deletes.contains(&row.key))
            .collect();
        remaining.sort_by_key(|row| row.sequence);
        let mut ordered: Vec<_> = incoming.into_values().collect();
        ordered.sort_by_key(|(position, _)| *position);
        let mut additions = Vec::new();
        for (index, (_, entry)) in ordered.into_iter().enumerate() {
            additions.push(Row {
                namespace: namespace.clone(),
                key: entry.key,
                payload: entry.payload,
                sequence: next
                    .checked_add(index as i64)
                    .ok_or_else(|| limit("sequence exhausted"))?,
            });
        }
        let mut count = remaining.len() + additions.len();
        let mut bytes: usize = remaining
            .iter()
            .chain(additions.iter())
            .map(Row::bytes)
            .sum();
        let mut evicted = 0;
        while count > max_entries || bytes > max_bytes {
            let row = &remaining[evicted];
            deletes.insert(row.key.clone());
            bytes -= row.bytes();
            count -= 1;
            evicted += 1;
        }
        let mut projected = all_rows(db, memory)?;
        projected.retain(|row| row.namespace != namespace);
        let total: usize = projected.iter().map(Row::bytes).sum::<usize>() + bytes;
        if total > if memory { 36 * MIB } else { 96 * MIB } {
            return Err(limit("database logical budget exceeded"));
        }
        let mut tx = db.begin_transaction().map_err(engine_open_error)?;
        for key in deletes {
            tx.query_sql_with_params(
                DELETE_ONE,
                &[Value::String(namespace.clone()), Value::String(key)],
            )
            .map_err(unavailable)?;
        }
        for (index, row) in additions.iter().enumerate() {
            tx.query_sql_with_params(
                INSERT_ONE,
                &[
                    Value::String(namespace.clone()),
                    Value::String(row.key.clone()),
                    Value::Binary(row.payload.as_bytes().to_vec()),
                    Value::Int(row.sequence),
                ],
            )
            .map_err(unavailable)?;
            #[cfg(feature = "test-hooks")]
            if index == 0 {
                transaction_test_hook()?;
            }
            #[cfg(not(feature = "test-hooks"))]
            let _ = index;
        }
        tx.commit().map_err(unavailable)?;
        maintain(&mut handle, input_bytes + bytes, additions.len() + evicted)?;
        Ok(())
    }
    #[napi]
    pub fn clear_namespace(&self, namespace: String) -> napi::Result<()> {
        let mut handle = self.ready()?;
        namespace_quota(&namespace, handle.memory)?;
        if handle.read_only {
            return Err(err("HawdbIncompatible", "database is read-only"));
        }
        let db = active_mut(&mut handle)?;
        let prior = read_rows(db, &namespace)?;
        db.query_sql_with_params(DELETE_NS, &[Value::String(namespace)])
            .map_err(unavailable)?;
        let bytes: usize = prior.iter().map(Row::bytes).sum();
        maintain(&mut handle, bytes, prior.len())
    }
    #[napi]
    pub fn namespaces(&self) -> napi::Result<Vec<String>> {
        let handle = self.ready()?;
        let db = active(&handle)?;
        let mut result = Vec::new();
        for name in namespaces(handle.memory) {
            if !read_rows(db, name)?.is_empty() {
                result.push((*name).into());
            }
        }
        Ok(result)
    }
    #[napi]
    pub fn reclaim(&self) -> napi::Result<ReclamationReport> {
        let mut handle = self.ready()?;
        if handle.memory || handle.read_only {
            return Err(err(
                "HawdbIncompatible",
                "reclamation requires a writable persistent handle",
            ));
        }
        handle
            .lease
            .as_ref()
            .map(ConcordLease::verify)
            .transpose()?;
        let db = active_mut(&mut handle)?;
        db.checkpoint().map_err(unavailable)?;
        let report = db
            .reclaim_branch_storage(hawdb::BranchReclamationLimits::default())
            .map_err(unavailable)?;
        Ok(ReclamationReport {
            reclaimed_objects: report.reclaimed_objects as f64,
            reclaimed_bytes: report.reclaimed_bytes as f64,
            deferred_for_active_leases: report.deferred_for_active_leases,
        })
    }
    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        self.ready()?.closing = true;
        finish_close(&self.handle)
    }

    #[napi]
    pub fn close_async<'env>(&self, env: &'env Env) -> napi::Result<PromiseRaw<'env, ()>> {
        self.ready()?.closing = true;
        let task = CloseTask {
            handle: Arc::clone(&self.handle),
        };
        // napi 3.13 may leak its task allocation when create/queue fails. Keep
        // reachable custody here until submission is known to have succeeded.
        let submitted = if lifecycle_failure("close-submit-failure") {
            std::mem::forget(task);
            Err(unavailable("injected async submission failure"))
        } else {
            env.spawn(task)
        };
        match submitted {
            Ok(work) => Ok(work.promise_object()),
            Err(error) => {
                let cleanup = finish_close(&self.handle);
                cleanup.and(Err(error))
            }
        }
    }
}
impl CacheBridge {
    fn ready(&self) -> napi::Result<MutexGuard<'_, Handle>> {
        let handle = self.handle.lock().map_err(unavailable)?;
        if handle.closing {
            return Err(err("HawdbClosed", "cache handle is closing"));
        }
        Ok(handle)
    }
}

// Resources leave the shared mutex before checkpoint, destruction, or I/O.
// A leaked task or JS shell can retain this Arc, but cannot retain its database.
fn finish_close(shared: &Arc<Mutex<Handle>>) -> napi::Result<()> {
    finish_close_at_barrier(shared, false)
}

fn finish_close_at_barrier(shared: &Arc<Mutex<Handle>>, wait: bool) -> napi::Result<()> {
    let mut owned = {
        let mut handle = shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        Handle {
            db: handle.db.take(),
            lease: handle.lease.take(),
            path: handle.path.take(),
            memory: handle.memory,
            read_only: handle.read_only,
            writes: 0,
            churn: 0,
            poisoned: handle.poisoned,
            closing: true,
        }
    };
    let barrier = if wait {
        lifecycle_wait("close")
    } else {
        Ok(())
    };
    let result = close_owned(&mut owned);
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .closing = false;
    barrier.and(result)
}

fn close_owned(handle: &mut Handle) -> napi::Result<()> {
    let mut db = handle.db.take();
    let safe = handle.lease.as_ref().map(ConcordLease::verify).transpose();
    let checkpoint = if safe.is_ok() && !handle.memory && !handle.read_only && !handle.poisoned {
        db.as_mut()
            .map(|db| db.checkpoint())
            .transpose()
            .map(|_| ())
            .map_err(unavailable)
    } else {
        Ok(())
    };
    drop(db);
    let inspected = if safe.is_ok() && checkpoint.is_ok() {
        handle
            .path
            .as_ref()
            .map(|path| inspect_tree(path, false))
            .transpose()
            .map(|_| ())
    } else {
        Ok(())
    };
    handle.lease = None;
    safe.map(|_| ()).and(checkpoint).and(inspected)
}

pub struct OpenTask {
    path: String,
    read_only: bool,
    create: bool,
    custody: Option<Arc<Mutex<Handle>>>,
    wrapped: bool,
}

impl Drop for OpenTask {
    fn drop(&mut self) {
        if let Some(shared) = self.custody.take() {
            let _ = finish_close(&shared);
        }
    }
}

impl<'task> ScopedTask<'task> for OpenTask {
    type Output = CacheBridge;
    type JsValue = ClassInstance<'task, CacheBridge>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let bridge = CacheBridge::new(self.path.clone(), self.read_only, self.create)?;
        self.custody = Some(Arc::clone(&bridge.handle));
        lifecycle_wait("open")?;
        Ok(bridge)
    }

    fn resolve(&mut self, env: &'task Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        if lifecycle_failure("open-before-wrap") {
            return Err(unavailable("injected before JS wrapping"));
        }
        let instance = output.into_instance(env)?;
        if lifecycle_failure("open-after-wrap") {
            return Err(unavailable("injected after JS wrapping"));
        }
        // finally also runs after a successful rejection: only an Ok resolve
        // with a wrapped instance can authorize the ownership handoff.
        self.wrapped = true;
        Ok(instance)
    }

    fn finally(mut self, _env: Env) -> napi::Result<()> {
        if self.wrapped && !lifecycle_failure("open-unsettled") {
            self.custody = None;
        }
        Ok(())
    }
}

#[napi]
pub fn open_cache(path: String, read_only: bool, create: bool) -> AsyncTask<OpenTask> {
    AsyncTask::new(OpenTask {
        path,
        read_only,
        create,
        custody: None,
        wrapped: false,
    })
}

struct CloseTask {
    handle: Arc<Mutex<Handle>>,
}
impl Task for CloseTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        finish_close_at_barrier(&self.handle, true)
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> napi::Result<()> {
        Ok(())
    }
}

fn lifecycle_failure(stage: &str) -> bool {
    #[cfg(feature = "test-hooks")]
    {
        std::env::var("CONCORD_HAWDB_LIFECYCLE_FAILURE").is_ok_and(|value| value == stage)
    }
    #[cfg(not(feature = "test-hooks"))]
    {
        let _ = stage;
        false
    }
}

fn lifecycle_wait(stage: &str) -> napi::Result<()> {
    #[cfg(feature = "test-hooks")]
    {
        if std::env::var("CONCORD_HAWDB_LIFECYCLE_WAIT").is_ok_and(|value| value == stage) {
            let ready = std::env::var_os("CONCORD_HAWDB_LIFECYCLE_READY")
                .ok_or_else(|| unavailable("lifecycle ready path is required"))?;
            let release = std::env::var_os("CONCORD_HAWDB_LIFECYCLE_RELEASE")
                .ok_or_else(|| unavailable("lifecycle release path is required"))?;
            fs::write(ready, stage).map_err(unavailable)?;
            let start = std::time::Instant::now();
            while !Path::new(&release).exists() {
                if start.elapsed() > std::time::Duration::from_secs(30) {
                    return Err(unavailable("lifecycle barrier timed out"));
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
    #[cfg(not(feature = "test-hooks"))]
    let _ = stage;
    Ok(())
}

#[cfg(feature = "test-hooks")]
#[napi]
impl CacheBridge {
    #[napi(factory)]
    pub fn uncoordinated_for_test(
        path: String,
        read_only: bool,
        admit: bool,
    ) -> napi::Result<Self> {
        let path = Path::new(&path);
        inspect_path(path, false)?;
        inspect_tree(path, true)?;
        let db = Database::open_with_config(path, config(read_only)).map_err(engine_open_error)?;
        if admit {
            schema(&db)?;
        }
        Ok(Self {
            handle: Arc::new(Mutex::new(Handle {
                db: Some(db),
                lease: None,
                path: Some(path.to_owned()),
                memory: false,
                read_only,
                writes: 0,
                churn: 0,
                poisoned: false,
                closing: false,
            })),
        })
    }
}
fn active(handle: &Handle) -> napi::Result<&Database> {
    if handle.poisoned {
        return Err(unavailable(
            "checkpoint failed; cache handle is unavailable",
        ));
    }
    handle
        .db
        .as_ref()
        .ok_or_else(|| err("HawdbClosed", "cache handle is closed"))
}
fn active_mut(handle: &mut Handle) -> napi::Result<&mut Database> {
    if handle.poisoned {
        return Err(unavailable(
            "checkpoint failed; cache handle is unavailable",
        ));
    }
    handle
        .db
        .as_mut()
        .ok_or_else(|| err("HawdbClosed", "cache handle is closed"))
}
fn maintain(handle: &mut Handle, bytes: usize, count: usize) -> napi::Result<()> {
    handle.writes += 1;
    handle.churn = handle.churn.saturating_add(bytes.max(count * 64));
    if handle.memory {
        if handle.churn >= 64 * MIB || handle.writes >= 2048 {
            let rows = all_rows(active(handle)?, true)?;
            let mut rebuilt = Database::new_with_config(config(false));
            initialize(&mut rebuilt)?;
            let mut tx = rebuilt.begin_transaction().map_err(engine_open_error)?;
            for row in rows {
                tx.query_sql_with_params(
                    INSERT_ONE,
                    &[
                        Value::String(row.namespace),
                        Value::String(row.key),
                        Value::Binary(row.payload.into_bytes()),
                        Value::Int(row.sequence),
                    ],
                )
                .map_err(unavailable)?;
            }
            tx.commit().map_err(unavailable)?;
            handle.db = Some(rebuilt);
            handle.churn = 0;
            handle.writes = 0;
        }
    } else {
        if handle.churn < 4 * MIB && handle.writes < 32 {
            return Ok(());
        }
        if let Err(error) = active_mut(handle)?.checkpoint() {
            handle.poisoned = true;
            return Err(unavailable(format!("checkpoint failed: {error}")));
        }
        handle.churn = 0;
        handle.writes = 0;
    }
    Ok(())
}
fn is_owner_only(path: &Path) -> napi::Result<bool> {
    for entry in fs::read_dir(path).map_err(unsafe_path)? {
        if entry.map_err(unsafe_path)?.file_name() != LOCK {
            return Ok(false);
        }
    }
    Ok(true)
}

#[napi]
pub struct OwnerGuard {
    file: Option<File>,
    path: PathBuf,
    lease: Option<ConcordLease>,
    engine_locks: Vec<(PathBuf, File)>,
}
#[napi]
impl OwnerGuard {
    #[napi(constructor)]
    pub fn new(path: String) -> napi::Result<Self> {
        let path = Path::new(&path);
        inspect_path(path, true)?;
        let lease = ConcordLease::acquire(path)?;
        let mut locks = inspect_tree(path, false)?;
        let file =
            inspect_lock(path, true)?.ok_or_else(|| unavailable("ownership lock unavailable"))?;
        lock_file(&file)?;
        let root_lock = path.join(LOCK);
        if !locks.contains(&root_lock) {
            locks.push(root_lock.clone());
            locks.sort();
        }
        let mut engine_locks = Vec::new();
        for lock in &locks {
            if lock == &root_lock {
                continue;
            }
            let file = open_lock_file(lock, false)?;
            lock_file(&file)?;
            engine_locks.push((lock.clone(), file));
        }
        if inspect_tree(path, false)? != locks {
            return Err(unsafe_path(
                "engine lock membership changed during clear admission",
            ));
        }
        for (lock, file) in &engine_locks {
            verify_lock_file(file, lock)?;
        }
        let guard = Self {
            file: Some(file),
            path: path.to_owned(),
            lease: Some(lease),
            engine_locks,
        };
        guard.verify()?;
        Ok(guard)
    }
    #[napi]
    pub fn verify(&self) -> napi::Result<()> {
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| err("HawdbClosed", "ownership guard is closed"))?;
        self.lease
            .as_ref()
            .ok_or_else(|| err("HawdbClosed", "ownership guard is closed"))?
            .verify()?;
        verify_lock_file(file, &self.path.join(LOCK))
    }
    #[napi]
    pub fn close(&mut self) {
        self.engine_locks.clear();
        self.file = None;
        self.lease = None;
    }
}

#[cfg(feature = "test-hooks")]
fn transaction_test_hook() -> napi::Result<()> {
    if std::env::var_os("CONCORD_HAWDB_TEST_FAIL_AFTER_FIRST").is_some() {
        return Err(unavailable("test injection after first SQL mutation"));
    }
    if let Some(ready) = std::env::var_os("CONCORD_HAWDB_TEST_READY") {
        let ready = PathBuf::from(ready);
        let release = std::env::var_os("CONCORD_HAWDB_TEST_RELEASE")
            .ok_or_else(|| unavailable("missing test release path"))?;
        fs::write(ready, b"ready").map_err(unavailable)?;
        let release = PathBuf::from(release);
        while !release.exists() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    Ok(())
}
