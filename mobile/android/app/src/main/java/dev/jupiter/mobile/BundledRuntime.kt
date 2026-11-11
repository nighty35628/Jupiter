package dev.jupiter.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Installs only hash-verified APK assets. User ZIP imports belong to ProjectArchive. */
object BundledRuntime {
    data class Paths(
        val rootfs: File,
        val engine: File,
        val home: File,
        val workspaces: File,
        val temp: File,
        val resolv: File,
        val nativeDir: String,
    )

    private const val STAGE_TIMEOUT_SECONDS = 180L
    private const val SPACE_RESERVE = 32L * 1024 * 1024
    private val shaPattern = Regex("[0-9a-fA-F]{64}")

    private data class Bundle(
        val label: String,
        val asset: String,
        val sha: String,
        val bytes: Long,
        val unpackedBytes: Long,
        val versions: File,
        val payloadName: String,
    ) {
        val version: File get() = File(versions, sha)
        val payload: File get() = File(version, payloadName)
    }

    /**
     * Blocking worker-thread API. Reports actual phases, not synthetic percentages.
     * Existing versions and permanent user data are never removed, even after failure.
     * IOException covers invalid manifests, space, integrity, extraction and activation failures;
     * interruption is reported as InterruptedIOException with the interrupt flag preserved.
     */
    @Synchronized
    @Throws(IOException::class)
    fun prepare(context: Context, progress: (String) -> Unit): Paths {
        checkInterrupted()
        progress("Reading bundled runtime manifests")
        // /data/user/0 has a symlink ancestor; expose the canonical private root to ProjectArchive.
        val files = context.filesDir.canonicalFile
        val cache = context.cacheDir.canonicalFile
        ensureDirectory(files)
        ensureDirectory(cache)
        val runtimeVersions = File(files, "runtime-versions")
        val engineVersions = File(files, "engine-versions")
        ensureDirectory(runtimeVersions)
        ensureDirectory(engineVersions)
        val runtime = readManifest(context, "runtime-manifest.json").let {
            val rootfs = it.optJSONObject("rootfs")
                ?: throw IOException("Runtime manifest is missing rootfs")
            bundle(rootfs, "Runtime", "rootfs.bundle", runtimeVersions, "rootfs")
        }
        val engineManifest = readManifest(context, "engine-manifest.json")
        if (engineManifest.optString("kind") != "application") throw IOException("Application engine asset was not prepared")
        val engine = bundle(
            engineManifest,
            "Engine", "engine.bundle", engineVersions, "engine",
        )
        val pending = listOf(runtime, engine).filterNot { isReady(it) }
        val required = try {
            pending.fold(SPACE_RESERVE) { total, item ->
                Math.addExact(total, Math.addExact(item.bytes, item.unpackedBytes))
            }
        } catch (error: ArithmeticException) {
            throw IOException("Bundled runtime space estimate overflow", error)
        }
        if (pending.isNotEmpty()) {
            progress("Checking free space: need approximately $required bytes including reserve")
            val available = files.usableSpace
            if (available < required) {
                throw IOException("Insufficient runtime storage: need $required bytes, available $available bytes")
            }
        }
        for (item in listOf(runtime, engine)) {
            checkInterrupted()
            if (item in pending) install(context, item, progress)
            else progress("Using installed ${item.label.lowercase(Locale.ROOT)} ${item.sha}")
        }

        progress("Preparing persistent home and workspaces")
        val home = File(files, "home")
        val workspaces = File(files, "workspaces")
        val temp = File(cache, "runtime-tmp")
        for (directory in listOf(home, workspaces, File(workspaces, "default"), temp, File(temp, "proot"))) {
            ensureDirectory(directory)
        }
        progress("Updating DNS from the active network")
        val resolv = File(cache, "resolv.conf")
        writeResolvers(context, resolv)
        val nativeDir = File(context.applicationInfo.nativeLibraryDir).canonicalPath
        for (name in listOf("libproot.so", "libproot-loader.so")) {
            if (!File(nativeDir, name).isFile) throw IOException("Missing bundled native library: $name")
        }
        checkInterrupted()
        progress("Bundled runtime ready")
        return Paths(runtime.payload, engine.payload, home, workspaces, temp, resolv, nativeDir)
    }

    /** Returns the direct tracer argv; EngineService owns PID wrapping and supervision. */
    fun processBuilder(paths: Paths): ProcessBuilder {
        val certificates = "/etc/ssl/certs/ca-certificates.crt"
        val builder = ProcessBuilder(
            "${paths.nativeDir}/libproot.so", "-0", "--link2symlink", "-r", paths.rootfs.absolutePath,
            "-b", "/dev", "-b", "/proc",
            "-b", "${paths.engine.absolutePath}:/opt/jupiter",
            "-b", "${paths.home.absolutePath}:/home/jupiter",
            "-b", "${paths.workspaces.absolutePath}:/workspaces",
            "-b", "${paths.temp.absolutePath}:/tmp",
            "-b", "${paths.resolv.absolutePath}:/etc/resolv.conf",
            "-w", "/workspaces/default",
            "/usr/bin/env", "-i", "HOME=/home/jupiter", "PATH=/usr/local/bin:/usr/bin:/bin",
            "TMPDIR=/tmp", "SHELL=/bin/bash", "LANG=C.UTF-8",
            "NODE_EXTRA_CA_CERTS=$certificates", "SSL_CERT_FILE=$certificates", "GIT_SSL_CAINFO=$certificates",
            "/usr/local/bin/node", "--max-old-space-size=768", "/opt/jupiter/dist/cli/android.js",
        )
        builder.directory(paths.rootfs)
        builder.environment().apply {
            clear()
            put("LD_LIBRARY_PATH", paths.nativeDir)
            put("PROOT_LOADER", "${paths.nativeDir}/libproot-loader.so")
            put("PROOT_TMP_DIR", File(paths.temp, "proot").absolutePath)
            put("PROOT_NO_SECCOMP", "1")
        }
        return builder
    }

    private fun readManifest(context: Context, name: String): JSONObject {
        try {
            val bytes = context.assets.open(name).use { input ->
                val buffer = ByteArray(64 * 1024 + 1)
                var size = 0
                while (size < buffer.size) {
                    checkInterrupted()
                    val count = input.read(buffer, size, buffer.size - size)
                    if (count == -1) break
                    size += count
                }
                if (size > 64 * 1024) throw IOException("Bundled manifest too large: $name")
                buffer.copyOf(size)
            }
            return JSONObject(bytes.toString(Charsets.UTF_8))
        } catch (error: org.json.JSONException) {
            throw IOException("Invalid bundled manifest: $name", error)
        }
    }

    private fun bundle(json: JSONObject, label: String, asset: String, versions: File, payload: String): Bundle {
        val sha = json.opt("sha256") as? String
        if (sha == null || !shaPattern.matches(sha)) throw IOException("Invalid $label SHA-256")
        fun positiveLong(key: String): Long {
            val value = json.opt(key)
            val number = if (value is Number && Regex("[0-9]+").matches(value.toString())) {
                value.toString().toLongOrNull()
            } else null
            if (number == null || number <= 0) throw IOException("Invalid $label $key")
            return number
        }
        val bytes = positiveLong("bytes")
        val unpacked = if (json.has("unpackedBytes")) positiveLong("unpackedBytes") else try {
            Math.multiplyExact(bytes, 5L)
        } catch (error: ArithmeticException) {
            throw IOException("Invalid $label expanded size estimate", error)
        }
        return Bundle(label, asset, sha.lowercase(Locale.ROOT), bytes, unpacked, versions, payload)
    }

    private fun isReady(bundle: Bundle): Boolean {
        val version = bundle.version.toPath()
        if (!Files.exists(version, NOFOLLOW_LINKS)) return false
        val marker = version.resolve("ready")
        if (!Files.isDirectory(version, NOFOLLOW_LINKS) ||
            !Files.isDirectory(bundle.payload.toPath(), NOFOLLOW_LINKS) ||
            !Files.isRegularFile(marker, NOFOLLOW_LINKS) || Files.size(marker) != 64L ||
            Files.newInputStream(marker, NOFOLLOW_LINKS).use { it.readBytes().toString(Charsets.US_ASCII) } != bundle.sha
        ) {
            // Never repair an occupied version by deleting it; old engines may still be using it.
            throw IOException("Incomplete or invalid ${bundle.label} version: ${bundle.sha}")
        }
        return true
    }

    private fun install(context: Context, bundle: Bundle, progress: (String) -> Unit) {
        val staging = Files.createTempDirectory(bundle.versions.toPath(), ".staging-")
        var failure: Throwable? = null
        var activated = false
        try {
            val archive = staging.resolve("archive.tar.gz").toFile()
            progress("Copying ${bundle.label.lowercase(Locale.ROOT)} archive (${bundle.bytes} bytes)")
            copyAsset(context, bundle, archive)
            progress("Verifying ${bundle.label.lowercase(Locale.ROOT)} archive SHA-256")
            verifyArchive(bundle, archive)
            val payload = staging.resolve(bundle.payloadName).toFile()
            ensureDirectory(payload)
            progress("Extracting ${bundle.label.lowercase(Locale.ROOT)} archive")
            val log = staging.resolve("extract.log").toFile()
            extract(archive, payload, log)
            Files.delete(archive.toPath())
            Files.deleteIfExists(log.toPath())
            progress("Activating ${bundle.label.lowercase(Locale.ROOT)} ${bundle.sha}")
            FileOutputStream(staging.resolve("ready").toFile()).use {
                it.write(bundle.sha.toByteArray(Charsets.US_ASCII))
                it.fd.sync()
            }
            checkInterrupted()
            if (Files.exists(bundle.version.toPath(), NOFOLLOW_LINKS)) {
                throw IOException("${bundle.label} version already exists; refusing to replace it")
            }
            Files.move(staging, bundle.version.toPath(), ATOMIC_MOVE)
            activated = true
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            if (!activated) {
                try {
                    deleteStaging(staging)
                } catch (cleanup: Throwable) {
                    if (failure != null) failure.addSuppressed(cleanup) else throw cleanup
                }
            }
        }
    }

    private fun copyAsset(context: Context, bundle: Bundle, target: File) {
        val deadline = SystemClock.elapsedRealtime() + TimeUnit.SECONDS.toMillis(STAGE_TIMEOUT_SECONDS)
        var copied = 0L
        context.assets.open(bundle.asset).use { input ->
            FileOutputStream(target).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    checkCopyDeadline(deadline)
                    val count = input.read(buffer)
                    checkCopyDeadline(deadline)
                    if (count == -1) break
                    if (count == 0) continue
                    if (count.toLong() > bundle.bytes - copied) {
                        throw IOException("${bundle.label} archive exceeds manifest bytes")
                    }
                    output.write(buffer, 0, count)
                    copied += count
                }
                checkCopyDeadline(deadline)
            }
        }
        if (copied != bundle.bytes) throw IOException("${bundle.label} archive size mismatch")
    }

    private fun verifyArchive(bundle: Bundle, archive: File) {
        val deadline = SystemClock.elapsedRealtime() + TimeUnit.SECONDS.toMillis(STAGE_TIMEOUT_SECONDS)
        val digest = MessageDigest.getInstance("SHA-256")
        var verified = 0L
        archive.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                checkCopyDeadline(deadline)
                val count = input.read(buffer)
                checkCopyDeadline(deadline)
                if (count == -1) break
                if (count == 0) continue
                if (count.toLong() > bundle.bytes - verified) {
                    throw IOException("${bundle.label} archive exceeds manifest bytes")
                }
                digest.update(buffer, 0, count)
                verified += count
            }
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (verified != bundle.bytes || actual != bundle.sha) {
            throw IOException("${bundle.label} archive size or SHA-256 mismatch")
        }
    }

    private fun extract(archive: File, payload: File, log: File) {
        checkInterrupted()
        val builder = ProcessBuilder(
            "/system/bin/toybox", "tar", "-xzf", archive.absolutePath, "-C", payload.absolutePath,
        ).redirectErrorStream(true).redirectOutput(log)
        builder.environment().apply {
            clear()
            // toybox tar may resolve its compression helper through PATH, never a user path.
            put("PATH", "/system/bin")
        }
        val process = builder.start()
        var failure: Throwable? = null
        try {
            process.outputStream.close()
            if (!process.waitFor(STAGE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw IOException("Bundled archive extraction timed out after $STAGE_TIMEOUT_SECONDS seconds")
            }
            if (process.exitValue() != 0) {
                val detail = log.inputStream().use { input ->
                    val bytes = ByteArray(4096)
                    val count = input.read(bytes)
                    if (count > 0) String(bytes, 0, count, Charsets.UTF_8) else ""
                }
                throw IOException("Bundled archive extraction exited ${process.exitValue()}: $detail")
            }
        } catch (error: InterruptedException) {
            Thread.currentThread().interrupt()
            val interrupted = InterruptedIOException("Bundled archive extraction interrupted")
            interrupted.initCause(error)
            failure = interrupted
            throw interrupted
        } catch (error: Throwable) {
            failure = error
            throw error
        } finally {
            // Reap the owned toybox on every exceptional path before removing its staging tree.
            var interrupted = Thread.interrupted()
            var cleanupFailure: Throwable? = null
            try {
                if (process.isAlive) process.destroyForcibly()
                val deadline = SystemClock.elapsedRealtime() + TimeUnit.SECONDS.toMillis(5)
                while (process.isAlive) {
                    val remaining = deadline - SystemClock.elapsedRealtime()
                    if (remaining <= 0) throw IOException("Could not reap bundled archive extractor")
                    try {
                        process.waitFor(remaining, TimeUnit.MILLISECONDS)
                    } catch (_: InterruptedException) {
                        interrupted = true
                    }
                }
            } catch (cleanup: Throwable) {
                cleanupFailure = cleanup
            } finally {
                for (stream in listOf(process.inputStream, process.errorStream, process.outputStream)) {
                    try {
                        stream.close()
                    } catch (cleanup: Throwable) {
                        if (cleanupFailure != null) cleanupFailure.addSuppressed(cleanup) else cleanupFailure = cleanup
                    }
                }
                if (interrupted) Thread.currentThread().interrupt()
            }
            if (cleanupFailure != null) {
                if (failure != null) failure.addSuppressed(cleanupFailure)
                else throw IOException("Extractor cleanup failed", cleanupFailure)
            }
        }
    }

    private fun writeResolvers(context: Context, target: File) {
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val servers = try {
            connectivity?.activeNetwork?.let { connectivity.getLinkProperties(it)?.dnsServers }.orEmpty()
        } catch (_: SecurityException) {
            // Missing network visibility must not prevent offline history access.
            emptyList()
        }
        val content = servers.mapNotNull { it.hostAddress }.distinct().joinToString("") { "nameserver $it\n" }
        val staging = Files.createTempFile(target.parentFile!!.toPath(), ".resolv-", ".tmp")
        try {
            FileOutputStream(staging.toFile()).use {
                it.write(content.toByteArray(Charsets.US_ASCII))
                it.fd.sync()
            }
            Files.move(staging, target.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
        } finally {
            Files.deleteIfExists(staging)
        }
    }

    private fun ensureDirectory(directory: File) {
        if (!directory.exists() && !directory.mkdirs()) throw IOException("Cannot create directory: $directory")
        if (!Files.isDirectory(directory.toPath(), NOFOLLOW_LINKS)) {
            throw IOException("Expected a private directory, not a file or symlink: $directory")
        }
    }

    private fun checkInterrupted() {
        if (Thread.currentThread().isInterrupted) throw InterruptedIOException("Bundled runtime preparation interrupted")
    }

    private fun checkCopyDeadline(deadline: Long) {
        checkInterrupted()
        if (SystemClock.elapsedRealtime() >= deadline) throw IOException("Bundled archive I/O timed out")
    }

    private fun deleteStaging(staging: Path) {
        Files.walkFileTree(staging, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                Files.delete(file)
                return FileVisitResult.CONTINUE
            }

            override fun postVisitDirectory(dir: Path, exception: IOException?): FileVisitResult {
                if (exception != null) throw exception
                Files.delete(dir)
                return FileVisitResult.CONTINUE
            }
        })
    }
}
