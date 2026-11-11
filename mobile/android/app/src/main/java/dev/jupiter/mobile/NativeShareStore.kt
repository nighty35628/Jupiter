package dev.jupiter.mobile

import java.io.File
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.net.URI
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardOpenOption.CREATE_NEW
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.FileTime
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.Properties
import java.util.UUID

/** A private FIFO journal. Reading never dequeues; acknowledgement or confirmed discard removes the head. */
internal class NativeShareStore(
    directory: File,
    private val byteLimit: Long = MAX_BYTES,
    private val queueLimits: QueueLimits = QueueLimits(),
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    data class QueueLimits(
        val maxPending: Int = 16,
        val maxPendingBytes: Long = 512L * 1024 * 1024,
        val maxCompletedReceipts: Int = 128,
        val receiptTtlMillis: Long = 7L * 24 * 60 * 60 * 1000,
    ) {
        init { require(maxPending > 0 && maxPendingBytes > 0 && maxCompletedReceipts > 0 && receiptTtlMillis > 0) }
    }
    private val root = directory.toPath().toAbsolutePath().normalize()
    init { require(byteLimit in 1..MAX_BYTES) }
    data class Pending(val id: String, val text: String, val uris: List<String>, val mime: String, val order: Long)
    data class SharedFile(val id: String, val name: String, val mime: String, val size: Long)
    data class Share(val id: String, val text: String, val files: List<SharedFile>)
    data class Source(val name: String, val mime: String?, val input: InputStream)

    fun enqueue(id: String, text: String, uris: List<String>, mime: String?) = synchronized(journalLock) {
        require(isId(id) && uris.size <= MAX_FILES && uris.all(::isContentUri)) { "Only up to 12 content files can be shared" }
        require(text.length <= MAX_TEXT_CHARS && (text.isNotEmpty() || uris.isNotEmpty())) { "Share is empty or text is too long" }
        ensureRoot()
        for (pattern in listOf(".intake-*", ".pin-*")) {
            Files.newDirectoryStream(root, pattern).use { abandoned -> abandoned.forEach { deleteTree(it) } }
        }
        val destination = root.resolve(id)
        val receipt = root.resolve(".seen-$id")
        if (Files.isRegularFile(receipt, NOFOLLOW_LINKS) && !Files.exists(destination.resolve("pending"), NOFOLLOW_LINKS)) {
            rememberIntake(id); pruneReceipts(pending()); return@synchronized
        }
        if (Files.exists(destination, NOFOLLOW_LINKS)) {
            val existing = readPending(destination)
            require(existing.text == text && existing.uris == uris && existing.mime == mimeType(mime)) { "Intake token was already used" }
            if (!Files.exists(receipt, NOFOLLOW_LINKS)) Files.createFile(receipt)
            rememberIntake(id); pruneReceipts(pending())
            return@synchronized
        }
        val queued = pending()
        pruneReceipts(queued)
        if (queued.size >= queueLimits.maxPending) throw IOException("Pending share count limit reached")
        val reserved = reservedBytes(queued)
        val order = maxOf(nowMillis(), (queued.maxOfOrNull { it.order } ?: 0L) + 1)
        val stage = Files.createTempDirectory(root, ".intake-")
        try {
            val metadata = Properties().apply {
                setProperty("id", id); setProperty("text", text); setProperty("mime", mimeType(mime)); setProperty("order", order.toString())
                setProperty("count", uris.size.toString())
                uris.forEachIndexed { index, uri -> setProperty("uri.$index", uri) }
            }
            writeProperties(stage.resolve("pending"), metadata)
            val required = Files.size(stage.resolve("pending")) + MAX_MANIFEST_BYTES + if (uris.isEmpty()) 0L else byteLimit
            if (required > queueLimits.maxPendingBytes - reserved) throw IOException("Pending share byte limit reached")
            Files.move(stage, destination, ATOMIC_MOVE)
            Files.createFile(receipt)
            Files.setLastModifiedTime(receipt, FileTime.fromMillis(nowMillis()))
            rememberIntake(id)
            pruneReceipts(queued + readPending(destination))
        } finally { deleteTree(stage) }
    }

    fun first(): Pending? = synchronized(journalLock) { pending().minByOrNull { it.order } }

    fun containsIntake(id: String): Boolean = isId(id) &&
        (Files.isRegularFile(root.resolve(".seen-$id"), NOFOLLOW_LINKS) || Files.isRegularFile(root.resolve(id).resolve("pending"), NOFOLLOW_LINKS))

    fun stage(id: String, open: (String) -> Source, allowed: () -> Boolean): Share {
        checkAllowed(allowed)
        val pending = synchronized(journalLock) {
            val head = first() ?: throw IOException("No share is pending")
            require(head.id == id) { "Only the queued head can be consumed" }
            // Admission quotas must not prevent older, over-budget queues from draining.
            if (!activeStages.add(root.resolve(id))) throw IOException("Share staging is already active")
            head
        }
        try { return stageHead(pending, open, allowed) }
        finally { synchronized(journalLock) { activeStages.remove(root.resolve(id)) } }
    }

    private fun stageHead(pending: Pending, open: (String) -> Source, allowed: () -> Boolean): Share {
        val id = pending.id
        val directory = shareDirectory(id)
        Files.newDirectoryStream(directory, ".stage-*").use { abandoned -> abandoned.forEach { deleteTree(it, allowed) } }
        val destination = directory.resolve("files")
        if (Files.exists(destination, NOFOLLOW_LINKS)) {
            val cached = try { readShare(pending) } catch (_: Exception) { null }
            checkAllowed(allowed)
            if (cached != null) return cached
            // An explicitly retried consume can repair an interrupted acknowledgement.
            deleteTree(destination, allowed)
        }
        val stage = Files.createTempDirectory(directory, ".stage-")
        try {
            var total = 0L
            val files = pending.uris.map { uri ->
                checkAllowed(allowed)
                val source = open(uri)
                val fileId = UUID.randomUUID().toString()
                var size = 0L
                source.input.use { input ->
                    checkAllowed(allowed)
                    Files.newOutputStream(stage.resolve(fileId), CREATE_NEW, WRITE, NOFOLLOW_LINKS).use { output ->
                        val buffer = ByteArray(65536)
                        while (true) {
                            checkAllowed(allowed)
                            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), byteLimit - total + 1).toInt())
                            checkAllowed(allowed)
                            if (count == -1) break
                            if (count == 0) continue
                            total += count; size += count
                            if (total > byteLimit) throw IOException("Shared files exceed 100 MiB")
                            output.write(buffer, 0, count)
                        }
                    }
                }
                SharedFile(fileId, fileName(source.name), mimeType(source.mime), size)
            }
            val metadata = Properties().apply {
                setProperty("count", files.size.toString())
                files.forEachIndexed { index, file ->
                    setProperty("id.$index", file.id); setProperty("name.$index", file.name)
                    setProperty("mime.$index", file.mime); setProperty("size.$index", file.size.toString())
                }
            }
            writeProperties(stage.resolve("manifest"), metadata)
            check(Files.size(stage.resolve("manifest")) <= MAX_MANIFEST_BYTES)
            synchronized(journalLock) {
                checkAllowed(allowed)
                Files.move(stage, destination, ATOMIC_MOVE)
            }
            return Share(id, pending.text, files)
        } finally { deleteTree(stage) }
    }

    fun open(share: Share, fileId: String): InputStream {
        require(isId(fileId))
        val file = share.files.firstOrNull { it.id == fileId } ?: throw IOException("Unknown shared file")
        val directory = shareDirectory(share.id).resolve("files")
        check(Files.isDirectory(directory, NOFOLLOW_LINKS)) { "Invalid staged share" }
        val path = directory.resolve(file.id)
        requireRegularFile(path, file.size)
        return Files.newInputStream(path, NOFOLLOW_LINKS)
    }

    fun acknowledge(consumed: Share, id: String, allowed: () -> Boolean) = synchronized(journalLock) {
        require(isId(id) && consumed.id == id && first()?.id == id) { "Share was not consumed by this page" }
        removeHead(id, allowed)
    }

    /** The caller must obtain native confirmation for this captured head, not a later queue entry. */
    fun discard(head: String, allowed: () -> Boolean): Boolean = synchronized(journalLock) {
        require(isId(head)) { "Invalid share identity" }
        checkAllowed(allowed)
        if (first()?.id != head) return@synchronized false
        removeHead(head, allowed)
        true
    }

    private fun removeHead(id: String, allowed: () -> Boolean) {
        checkAllowed(allowed)
        val directory = shareDirectory(id)
        if (directory in activeStages) throw IOException("Share staging is still active")
        val receipt = root.resolve(".seen-$id")
        if (Files.exists(receipt, NOFOLLOW_LINKS)) check(Files.isRegularFile(receipt, NOFOLLOW_LINKS))
        else Files.createFile(receipt)
        // Keep the intake journal until deletion succeeds; failures must not silently dequeue it.
        val files = directory.resolve("files")
        if (Files.exists(files, NOFOLLOW_LINKS)) deleteTree(files, allowed)
        Files.newDirectoryStream(directory, ".stage-*").use { stages -> stages.forEach { deleteTree(it, allowed) } }
        checkAllowed(allowed)
        Files.setLastModifiedTime(receipt, FileTime.fromMillis(nowMillis()))
        Files.delete(directory.resolve("pending"))
        runCatching { Files.delete(directory) }
        runCatching { pruneReceipts(pending()) }
    }

    private fun reservedBytes(queued: List<Pending>): Long {
        var total = 0L
        for (entry in queued) {
            val cost = Files.size(root.resolve(entry.id).resolve("pending")) + MAX_MANIFEST_BYTES + if (entry.uris.isEmpty()) 0L else byteLimit
            if (cost > queueLimits.maxPendingBytes - total) throw IOException("Pending share byte limit reached")
            total += cost
        }
        return total
    }

    private fun rememberIntake(id: String) {
        val pin = root.resolve(".last-intake")
        if (Files.exists(pin, NOFOLLOW_LINKS)) {
            requireRegularFile(pin, 36)
            if (Files.newInputStream(pin, NOFOLLOW_LINKS).use { String(it.readBytes(), Charsets.US_ASCII) } == id) return
        }
        val temporary = Files.createTempFile(root, ".pin-", ".tmp")
        try {
            Files.newOutputStream(temporary, WRITE, NOFOLLOW_LINKS).use { it.write(id.toByteArray(Charsets.US_ASCII)) }
            Files.move(temporary, pin, ATOMIC_MOVE)
        } finally { Files.deleteIfExists(temporary) }
    }

    private fun pruneReceipts(queued: List<Pending>) {
        val pendingIds = queued.mapTo(mutableSetOf()) { it.id }
        val protected = pendingIds.toMutableSet()
        val pin = root.resolve(".last-intake")
        if (Files.exists(pin, NOFOLLOW_LINKS)) {
            requireRegularFile(pin, 36)
            val id = Files.newInputStream(pin, NOFOLLOW_LINKS).use { String(it.readBytes(), Charsets.US_ASCII) }
            check(isId(id)); protected.add(id)
        }
        activeStages.filter { it.parent == root }.forEach { protected.add(it.fileName.toString()) }
        val completed = Files.newDirectoryStream(root, ".seen-*").use { entries ->
            entries.filter { isId(it.fileName.toString().removePrefix(".seen-")) && Files.isRegularFile(it, NOFOLLOW_LINKS) }
                .filter { it.fileName.toString().removePrefix(".seen-") !in pendingIds }
                .sortedBy { Files.getLastModifiedTime(it, NOFOLLOW_LINKS).toMillis() }
        }
        var remaining = completed.size
        for (receipt in completed) {
            val id = receipt.fileName.toString().removePrefix(".seen-")
            if (id in protected) continue
            val expired = nowMillis() - Files.getLastModifiedTime(receipt, NOFOLLOW_LINKS).toMillis() >= queueLimits.receiptTtlMillis
            if (expired || remaining > queueLimits.maxCompletedReceipts) { Files.delete(receipt); remaining-- }
        }
    }

    private fun pending(): List<Pending> {
        if (!Files.exists(root, NOFOLLOW_LINKS)) return emptyList()
        ensureRoot()
        return Files.newDirectoryStream(root).use { entries ->
            entries.filter { isId(it.fileName.toString()) && Files.exists(it.resolve("pending"), NOFOLLOW_LINKS) }.map(::readPending)
        }
    }

    private fun readPending(directory: Path): Pending {
        check(Files.isDirectory(directory, NOFOLLOW_LINKS)) { "Invalid share directory" }
        val metadata = readProperties(directory.resolve("pending"))
        val id = metadata.getProperty("id")
        require(isId(id) && directory.fileName.toString() == id)
        val count = metadata.getProperty("count").toInt()
        require(count in 0..MAX_FILES)
        val text = metadata.getProperty("text")
        require(text.length <= MAX_TEXT_CHARS)
        val uris = List(count) { metadata.getProperty("uri.$it") }
        require(uris.all(::isContentUri))
        return Pending(id, text, uris, mimeType(metadata.getProperty("mime")), metadata.getProperty("order").toLong())
    }

    private fun readShare(pending: Pending): Share {
        val directory = shareDirectory(pending.id).resolve("files")
        check(Files.isDirectory(directory, NOFOLLOW_LINKS)) { "Invalid staged share" }
        val metadata = readProperties(directory.resolve("manifest"))
        val count = metadata.getProperty("count").toInt()
        require(count == pending.uris.size && count in 0..MAX_FILES)
        var total = 0L
        val files = List(count) { index ->
            val id = metadata.getProperty("id.$index")
            require(isId(id))
            val size = metadata.getProperty("size.$index").toLong()
            require(size in 0..byteLimit)
            total += size
            require(total <= byteLimit)
            requireRegularFile(directory.resolve(id), size)
            SharedFile(id, fileName(metadata.getProperty("name.$index")), mimeType(metadata.getProperty("mime.$index")), size)
        }
        return Share(pending.id, pending.text, files)
    }

    private fun ensureRoot() {
        Files.createDirectories(root)
        check(Files.isDirectory(root, NOFOLLOW_LINKS) && root.toFile().canonicalFile.toPath() == root) { "Invalid share cache" }
    }

    private fun shareDirectory(id: String): Path {
        require(isId(id))
        ensureRoot()
        return root.resolve(id).also { check(Files.isDirectory(it, NOFOLLOW_LINKS)) { "Share is unavailable" } }
    }

    private fun requireRegularFile(path: Path, size: Long) {
        val attributes = Files.readAttributes(path, BasicFileAttributes::class.java, NOFOLLOW_LINKS)
        check(attributes.isRegularFile && attributes.size() == size) { "Shared file is unavailable" }
    }

    private fun writeProperties(path: Path, metadata: Properties) {
        Files.newOutputStream(path, CREATE_NEW, WRITE, NOFOLLOW_LINKS).use { metadata.store(it, null) }
    }

    private fun readProperties(path: Path): Properties {
        val size = Files.size(path)
        require(size in 0..MAX_METADATA_BYTES)
        requireRegularFile(path, size)
        return Properties().apply { Files.newInputStream(path, NOFOLLOW_LINKS).use { load(it) } }
    }

    private fun deleteTree(path: Path, allowed: () -> Boolean = { true }) {
        if (!Files.exists(path, NOFOLLOW_LINKS)) return
        Files.walkFileTree(path, object : SimpleFileVisitor<Path>() {
            override fun visitFile(file: Path, attributes: BasicFileAttributes): FileVisitResult {
                checkAllowed(allowed); Files.delete(file); return FileVisitResult.CONTINUE
            }
            override fun postVisitDirectory(directory: Path, failure: IOException?): FileVisitResult {
                if (failure != null) throw failure
                checkAllowed(allowed); Files.delete(directory); return FileVisitResult.CONTINUE
            }
        })
    }

    companion object {
        const val MAX_FILES = 12
        const val MAX_BYTES = 100L * 1024 * 1024
        const val MAX_TEXT_CHARS = 64 * 1024
        const val MAX_MANIFEST_BYTES = 32L * 1024
        private const val MAX_METADATA_BYTES = 1024L * 1024
        private val journalLock = Any()
        private val activeStages = mutableSetOf<Path>()
        private val metadataWork = ThreadPoolExecutor(0, 1, 30, TimeUnit.SECONDS, ArrayBlockingQueue(16),
            { Thread(it, "jupiter-share-metadata").apply { isDaemon = true } })
        fun executeMetadata(block: () -> Unit) { metadataWork.execute(block) }
        private val uuid = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        fun isId(value: String?) = value != null && uuid.matches(value)
        fun isContentUri(value: String): Boolean = value.length <= 8192 && runCatching {
            val uri = URI(value)
            uri.scheme == "content" && !uri.rawAuthority.isNullOrBlank() && uri.rawUserInfo == null
        }.getOrDefault(false)
        fun boundText(text: CharSequence?): String {
            val bounded = text?.subSequence(0, minOf(text.length, MAX_TEXT_CHARS))?.toString() ?: ""
            return if (bounded.lastOrNull()?.isHighSurrogate() == true) bounded.dropLast(1) else bounded
        }
        fun fileName(name: String): String = name.substringAfterLast('/').substringAfterLast('\\')
            .filterNot { it.isISOControl() }.take(160).ifBlank { "shared-file" }
        fun mimeType(mime: String?): String = mime?.takeIf { it.length <= 128 }?.substringBefore(';')?.trim()?.lowercase()
            ?.takeIf { Regex("[a-z0-9.+_-]+/[a-z0-9.+_-]+").matches(it) } ?: "application/octet-stream"
        fun acceptsCamera(types: List<String>): Boolean {
            val accepted = types.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            return accepted.isEmpty() || accepted.any { it in setOf("*/*", "image/*", "image/jpeg", ".jpg", ".jpeg") }
        }

        fun requestedFile(url: String, origin: String, shareId: String, token: String?): String? = runCatching {
            if (!isId(shareId) || token != shareId) return@runCatching null
            val base = URI(origin)
            val target = URI(url)
            if (base.scheme != "http" || base.host != "127.0.0.1" || base.port !in 1..65535 || base.rawUserInfo != null ||
                base.rawPath !in listOf("", "/") || base.rawQuery != null || base.rawFragment != null ||
                target.scheme != base.scheme || target.rawAuthority != base.rawAuthority || target.rawQuery != null || target.rawFragment != null) return@runCatching null
            val id = target.rawPath.removePrefix("/native-share/")
            id.takeIf { target.rawPath == "/native-share/$it" && isId(it) }
        }.getOrNull()

        fun guarded(input: InputStream, allowed: () -> Boolean): InputStream = object : FilterInputStream(input) {
            private fun checkAccess() {
                if (!allowed()) { close(); throw IOException("Share capability was revoked") }
            }
            override fun read(): Int { checkAccess(); val result = `in`.read(); checkAccess(); return result }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                checkAccess(); val count = `in`.read(buffer, offset, length); checkAccess(); return count
            }
            override fun skip(count: Long): Long { checkAccess(); return `in`.skip(count).also { checkAccess() } }
        }

        private fun checkAllowed(allowed: () -> Boolean) { if (!allowed()) throw IOException("Share operation was cancelled") }
    }
}
