package dev.jupiter.mobile

import java.io.File
import java.io.IOException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardOpenOption.WRITE
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

/** Display metadata lives beside projects, never inside an exported project or managed config. */
internal object ImportedProjectLabel {
    fun write(workspaces: File, directoryName: String, label: String, allowed: () -> Boolean) {
        require(runCatching { UUID.fromString(directoryName).toString() == directoryName }.getOrDefault(false))
        val bytes = label.toByteArray(Charsets.UTF_8)
        require(label.isNotBlank() && label.length <= 100 && bytes.size <= 400 && label.none { it.isISOControl() })
        fun checkActive() { if (!allowed()) throw IOException("Project name write was cancelled") }
        val root = workspaces.toPath().toAbsolutePath().normalize()
        checkActive()
        check(Files.readAttributes(root, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory)
        check(Files.readAttributes(root.resolve(directoryName), BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory)
        val names = root.resolve(".names")
        checkActive()
        try { Files.createDirectory(names, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))) }
        catch (_: FileAlreadyExistsException) { /* Validate an existing directory without following links. */ }
        check(Files.readAttributes(names, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory)
        val target = names.resolve("$directoryName.txt")
        if (Files.exists(target, NOFOLLOW_LINKS)) {
            check(Files.readAttributes(target, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isRegularFile)
        }
        checkActive()
        val temporary = Files.createTempFile(names, ".$directoryName-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        try {
            Files.newOutputStream(temporary, WRITE, NOFOLLOW_LINKS).use { output ->
                checkActive()
                output.write(bytes)
            }
            checkActive()
            check(Files.readAttributes(names, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isDirectory)
            if (Files.exists(target, NOFOLLOW_LINKS)) {
                check(Files.readAttributes(target, BasicFileAttributes::class.java, NOFOLLOW_LINKS).isRegularFile)
            }
            Files.move(temporary, target, ATOMIC_MOVE)
        } finally { Files.deleteIfExists(temporary) }
    }
}
