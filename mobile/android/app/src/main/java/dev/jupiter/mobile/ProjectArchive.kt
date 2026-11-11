package dev.jupiter.mobile

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.FileAlreadyExistsException
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.BasicFileAttributes
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream

/** Imports an independent copy; never retains a URI, external filename, or archive permissions. */
object ProjectArchive {
    data class Limits(
        val maxCompressedBytes: Long = 128L * 1024 * 1024,
        val maxExpandedBytes: Long = 512L * 1024 * 1024,
        val maxEntries: Int = 10_000,
        val maxPathBytes: Int = 1024,
        val maxSegmentBytes: Int = 255,
        val maxDepth: Int = 64,
    ) {
        init {
            require(maxCompressedBytes > 0 && maxExpandedBytes > 0)
            require(maxEntries > 0 && maxPathBytes > 0 && maxSegmentBytes > 0 && maxDepth > 0)
        }
    }

    data class Result(
        val directory: File,
        val entryCount: Int,
        val expandedBytes: Long,
        val compressedBytes: Long,
    )

    class InvalidArchiveException(message: String) : IOException(message)
    class LimitExceededException(message: String) : IOException(message)
    class ImportCancelledException : IOException("Project import cancelled")

    /**
     * Consumes and closes [input], including on failure. [projectsRoot] must be app-private and
     * must not be modified by untrusted/concurrent filesystem writers during the import.
     * Missing root directories are created; existing symlinks in its path are rejected.
     * Cancellation is cooperative between blocking reads, writes, and filesystem operations.
     *
     * Preserves all ZIP levels, including a sole top-level directory. Counts explicit entries
     * (including directories) and actual bytes, never advertised sizes. ZIP symlink metadata
     * is ignored: only new regular files/directories are created, with no executable bits copied.
     * A bounded private ZIP spool lets ZipFile validate the central directory after streaming
     * extraction. Empty/non-ZIP inputs are rejected. Unsupported atomic moves fail closed.
     */
    @Throws(IOException::class)
    fun importZip(
        input: InputStream,
        projectsRoot: File,
        limits: Limits = Limits(),
        isCancelled: () -> Boolean = { false },
    ): Result {
        var staging: Path? = null
        var spool: Path? = null
        try {
            val extracted = input.use { source ->
                checkCancelled(isCancelled)
                val root = projectsRoot.toPath().toAbsolutePath().normalize()
                ensureDirectories(root, isCancelled)
                val stage = Files.createTempDirectory(root, ".import-")
                staging = stage
                val archive = Files.createTempFile(root, ".import-input-", ".zip")
                spool = archive
                val entries = LinkedHashMap<String, EntryRecord>()
                var expanded = 0L
                var compressed = 0L
                Files.newOutputStream(archive, WRITE, NOFOLLOW_LINKS).use { copy ->
                    val bounded = object : InputStream() {
                        override fun read(): Int {
                            val one = ByteArray(1)
                            return if (read(one, 0, 1) == -1) -1 else one[0].toInt() and 0xff
                        }

                        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                            if (length == 0) return 0
                            checkCancelled(isCancelled)
                            val remaining = limits.maxCompressedBytes - compressed
                            val requested = if (remaining >= length) length else (remaining + 1).toInt()
                            val count = source.read(buffer, offset, requested)
                            checkCancelled(isCancelled)
                            if (count > 0) {
                                if (count > remaining) {
                                    throw LimitExceededException("Compressed input limit exceeded")
                                }
                                compressed += count
                                copy.write(buffer, offset, count)
                            }
                            return count
                        }

                        // ZipInputStream owns its inflater; the outer use owns source and copy.
                        override fun close() = Unit
                    }
                    val buffer = ByteArray(8192)
                    ZipInputStream(bounded).use { zip ->
                        while (true) {
                            checkCancelled(isCancelled)
                            val entry = zip.nextEntry ?: break
                            if (entries.size >= limits.maxEntries) {
                                throw LimitExceededException("ZIP entry limit exceeded")
                            }
                            val path = validatePath(entry.name, entry.isDirectory, limits)
                            if (entries.containsKey(path)) {
                                throw InvalidArchiveException("Duplicate ZIP path")
                            }
                            val target = stage.resolve(path).normalize()
                            if (!target.startsWith(stage) || target == stage) {
                                throw InvalidArchiveException("ZIP path escapes staging")
                            }
                            ensureDirectories(if (entry.isDirectory) target else target.parent, isCancelled)
                            var entryBytes = 0L
                            val checksum = CRC32()
                            fun consume(output: java.io.OutputStream?) {
                                while (true) {
                                    checkCancelled(isCancelled)
                                    val remaining = limits.maxExpandedBytes - expanded
                                    val requested = if (remaining >= buffer.size) buffer.size else (remaining + 1).toInt()
                                    val count = zip.read(buffer, 0, requested)
                                    checkCancelled(isCancelled)
                                    if (count == -1) break
                                    if (count == 0) continue
                                    if (count > remaining) {
                                        throw LimitExceededException("Expanded data limit exceeded")
                                    }
                                    if (entry.isDirectory) {
                                        throw InvalidArchiveException("Directory entry contains data")
                                    }
                                    expanded += count
                                    entryBytes += count
                                    checksum.update(buffer, 0, count)
                                    output!!.write(buffer, 0, count)
                                }
                            }
                            if (entry.isDirectory) {
                                consume(null)
                            } else {
                                Files.newOutputStream(target, CREATE_NEW, WRITE, NOFOLLOW_LINKS).use { consume(it) }
                            }
                            zip.closeEntry()
                            if (entry.size != entryBytes || entry.crc != checksum.value) {
                                throw InvalidArchiveException("ZIP entry metadata mismatch")
                            }
                            entries[path] = EntryRecord(entry.name, entryBytes, checksum.value, entry.method)
                        }
                        if (entries.isEmpty()) throw InvalidArchiveException("ZIP has no project entries")
                        // Include central-directory, comment, and trailing bytes in the input cap.
                        while (bounded.read(buffer) != -1) checkCancelled(isCancelled)
                    }
                }
                validateCentralDirectory(archive, entries, isCancelled)
                Files.delete(archive)
                spool = null
                Result(stage.toFile(), entries.size, expanded, compressed)
            }
            // Closing the input is part of the transaction, before its commit point.
            val stage = staging!!
            ensureDirectories(stage.parent, isCancelled)
            var destination: Path
            do {
                checkCancelled(isCancelled)
                destination = stage.parent.resolve(UUID.randomUUID().toString())
            } while (Files.exists(destination, NOFOLLOW_LINKS))
            val result = extracted.copy(directory = destination.toFile())
            checkCancelled(isCancelled)
            Files.move(stage, destination, ATOMIC_MOVE)
            staging = null
            return result
        } catch (failure: Throwable) {
            for (temporary in listOfNotNull(staging, spool)) {
                try {
                    deleteWithoutFollowingLinks(temporary)
                } catch (cleanupFailure: Throwable) {
                    failure.addSuppressed(cleanupFailure)
                }
            }
            throw failure
        }
    }

    private data class EntryRecord(val name: String, val bytes: Long, val crc: Long, val method: Int)

    private fun validateCentralDirectory(
        archive: Path,
        extracted: Map<String, EntryRecord>,
        isCancelled: () -> Boolean,
    ) {
        checkCancelled(isCancelled)
        ZipFile(archive.toFile()).use { zip ->
            if (zip.size() != extracted.size) throw InvalidArchiveException("ZIP directory entry count mismatch")
            val remaining = extracted.values.associateBy { it.name }.toMutableMap()
            val entries = zip.entries()
            while (entries.hasMoreElements()) {
                checkCancelled(isCancelled)
                val entry = entries.nextElement()
                val record = remaining.remove(entry.name)
                    ?: throw InvalidArchiveException("ZIP directory path mismatch")
                if (entry.size != record.bytes || entry.crc != record.crc || entry.method != record.method) {
                    throw InvalidArchiveException("ZIP directory metadata mismatch")
                }
            }
            if (remaining.isNotEmpty()) throw InvalidArchiveException("Incomplete ZIP directory")
        }
    }

    private fun validatePath(name: String, directory: Boolean, limits: Limits): String {
        if (name.isEmpty() || name.startsWith('/') || '\\' in name || '\u0000' in name ||
            (name.length >= 2 && name[0].isLetter() && name[1] == ':')
        ) {
            throw InvalidArchiveException("Unsafe ZIP path")
        }
        if (name.toByteArray(Charsets.UTF_8).size > limits.maxPathBytes) {
            throw LimitExceededException("ZIP path length limit exceeded")
        }
        val path = if (directory) name.dropLast(1) else name
        val segments = path.split('/')
        if (segments.size > limits.maxDepth) throw LimitExceededException("ZIP path depth limit exceeded")
        for (segment in segments) {
            if (segment.isEmpty() || segment == "." || segment == "..") {
                throw InvalidArchiveException("Unsafe ZIP path segment")
            }
            if (segment.toByteArray(Charsets.UTF_8).size > limits.maxSegmentBytes) {
                throw LimitExceededException("ZIP path segment limit exceeded")
            }
        }
        return path
    }

    private fun ensureDirectories(path: Path, isCancelled: () -> Boolean) {
        var current = path.root
        for (segment in path) {
            checkCancelled(isCancelled)
            current = current.resolve(segment)
            try {
                Files.createDirectory(current)
            } catch (_: FileAlreadyExistsException) {
                // NOFOLLOW rejects files and links, including links to directories.
            }
            if (!Files.readAttributes(current, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory) {
                throw InvalidArchiveException("Directory path contains a file or symbolic link")
            }
        }
    }

    private fun checkCancelled(isCancelled: () -> Boolean) {
        if (isCancelled()) throw ImportCancelledException()
    }

    private fun deleteWithoutFollowingLinks(path: Path) {
        Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
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
