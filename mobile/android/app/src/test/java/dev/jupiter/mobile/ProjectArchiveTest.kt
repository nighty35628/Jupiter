package dev.jupiter.mobile

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.util.UUID
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ProjectArchiveTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private val root: File get() = File(temporary.root.canonicalFile, "projects")

    @Test
    fun importsTextBinaryAndNestedPathsAndPreservesTopLevelDirectory() {
        val binary = byteArrayOf(0, 1, 2, 127, -1, -128)
        val archive = zip(
            "sample/" to byteArrayOf(),
            "sample/README.txt" to "hello\n".toByteArray(),
            "sample/nested/data.bin" to binary,
        )
        val input = TrackingInput(archive)
        val result = ProjectArchive.importZip(input, root)

        assertTrue(input.closed)
        assertEquals(UUID.fromString(result.directory.name).toString(), result.directory.name)
        assertEquals(root.canonicalFile, result.directory.parentFile.canonicalFile)
        assertEquals(3, result.entryCount)
        assertEquals(12L, result.expandedBytes)
        assertEquals(archive.size.toLong(), result.compressedBytes)
        assertEquals("hello\n", File(result.directory, "sample/README.txt").readText())
        assertArrayEquals(binary, File(result.directory, "sample/nested/data.bin").readBytes())
        assertEquals(listOf(result.directory.name), root.list()!!.toList())
    }

    @Test
    fun importsAreIndependentCopiesWithUniqueDirectories() {
        val archive = zip("a.txt" to byteArrayOf(42))
        val first = ProjectArchive.importZip(archive.inputStream(), root)
        val second = ProjectArchive.importZip(archive.inputStream(), root)
        assertNotEquals(first.directory, second.directory)
        File(first.directory, "a.txt").writeText("changed")
        assertArrayEquals(byteArrayOf(42), File(second.directory, "a.txt").readBytes())
        assertEquals(2, root.list()!!.size)
    }

    @Test
    fun rejectsUnsafePathsAndLeavesExistingProjectUntouched() {
        val names = listOf(
            "../outside.txt", "a/../../outside.txt", "/absolute.txt", "C:/drive.txt", "C:drive.txt",
            "//server/share/file", "\\\\server\\share\\file", "a\\b.txt", "a/../b", "a/./b",
            "./a", "a//b", "a\u0000b", "/", "a//",
        )
        for (name in names) {
            assertFailurePreservesExisting(zip("safe.txt" to byteArrayOf(1), name to byteArrayOf()))
        }
        assertFalse(File(temporary.root.canonicalFile, "outside.txt").exists())
    }

    @Test
    fun rejectsDuplicateFilesDirectoriesAndFileDirectoryConflicts() {
        val duplicate = zip("a.txt" to byteArrayOf(1), "b.txt" to byteArrayOf(2))
        // ZipOutputStream forbids duplicates; equal-length name substitution preserves ZIP layout.
        val duplicateNames = replaceName(duplicate, "b.txt", "a.txt")
        val duplicateDirectories = replaceName(zip("a/" to byteArrayOf(), "b/" to byteArrayOf()), "b/", "a/")
        val conflicts = listOf(
            duplicateNames,
            duplicateDirectories,
            zip("a" to byteArrayOf(1), "a/" to byteArrayOf()),
            zip("a/" to byteArrayOf(), "a" to byteArrayOf(1)),
            zip("a" to byteArrayOf(1), "a/b" to byteArrayOf(2)),
            zip("a/b" to byteArrayOf(1), "a" to byteArrayOf(2)),
        )
        for (archive in conflicts) assertFailurePreservesExisting(archive)
    }

    @Test
    fun acceptsExplicitDirectoryAfterItsImplicitCreation() {
        val result = ProjectArchive.importZip(zip("a/b" to byteArrayOf(1), "a/" to byteArrayOf()).inputStream(), root)
        assertEquals(2, result.entryCount)
        assertArrayEquals(byteArrayOf(1), File(result.directory, "a/b").readBytes())
    }

    @Test
    fun rejectsCorruptCrcAndTruncatedEntryData() {
        val payload = "unique-payload-for-stored-crc".toByteArray()
        val valid = storedZip("payload.bin", payload)
        val offset = findBytes(valid, payload)
        assertTrue(offset >= 0)
        val corrupt = valid.copyOf()
        corrupt[offset] = (corrupt[offset].toInt() xor 1).toByte()
        assertFailurePreservesExisting(corrupt, expected = ZipException::class.java)
        assertFailurePreservesExisting(valid.copyOf(offset + payload.size - 1))

        val deflated = zip("large.txt" to ByteArray(65536) { (it % 251).toByte() })
        assertFailurePreservesExisting(deflated.copyOf(45))
    }

    @Test
    fun rejectsInvalidCrcEvenForAnEmptyStoredEntry() {
        val archive = storedZip("empty", byteArrayOf())
        val central = findBytes(archive, byteArrayOf(0x50, 0x4b, 0x01, 0x02))
        assertTrue(central >= 0)
        // Keep the two advertised CRCs in agreement, but inconsistent with the empty data.
        archive[14] = 1
        archive[central + 16] = 1
        assertFailurePreservesExisting(archive)
    }

    @Test
    fun rejectsTruncatedOrMissingCentralDirectory() {
        val archive = zip("a.txt" to byteArrayOf(1, 2, 3))
        assertFailurePreservesExisting(archive.copyOf(archive.size - 1))
        assertFailurePreservesExisting(archive.copyOf(archive.size - 22))
    }

    @Test
    fun rejectsCentralDirectoryThatDisagreesWithLocalEntries() {
        val archive = zip("a.txt" to byteArrayOf(1))
        val changed = archive.copyOf()
        val name = "a.txt".toByteArray()
        val centralName = findBytes(changed, name, findBytes(changed, name) + name.size)
        assertTrue(centralName >= 0)
        changed[centralName] = 'b'.code.toByte()
        assertFailurePreservesExisting(changed)
    }

    @Test
    fun rejectsEmptyNonZipAndDirectoryPayloads() {
        for (archive in listOf(byteArrayOf(), "not a zip".toByteArray(), zip(), zip("dir/" to byteArrayOf(1)))) {
            assertFailurePreservesExisting(archive)
        }
    }

    @Test
    fun enforcesCompressedLimitIncludingTrailingBytes() {
        val archive = zip("a.txt" to byteArrayOf(1))
        val limit = ProjectArchive.Limits(maxCompressedBytes = archive.size.toLong())
        val result = ProjectArchive.importZip(archive.inputStream(), root, limit)
        assertEquals(archive.size.toLong(), result.compressedBytes)
        val published = root.list()!!.toSet()
        val trailing = archive + ByteArray(17)
        assertThrows(ProjectArchive.LimitExceededException::class.java) {
            ProjectArchive.importZip(trailing.inputStream(), root, limit)
        }
        assertEquals(published, root.list()!!.toSet())
        assertFailurePreservesExisting(archive, ProjectArchive.Limits(maxCompressedBytes = 16), ProjectArchive.LimitExceededException::class.java)
    }

    @Test
    fun enforcesExpandedLimitAcrossEntriesAndStopsHighlyCompressiblePayload() {
        val exact = zip("a" to byteArrayOf(1, 2), "b" to byteArrayOf(3, 4))
        val limits = ProjectArchive.Limits(maxExpandedBytes = 4)
        assertEquals(4L, ProjectArchive.importZip(exact.inputStream(), root, limits).expandedBytes)
        assertFailurePreservesExisting(
            zip("a" to byteArrayOf(1, 2), "b" to byteArrayOf(3, 4, 5)), limits,
            ProjectArchive.LimitExceededException::class.java,
        )
        assertFailurePreservesExisting(
            zip("bomb" to ByteArray(1024 * 1024)), ProjectArchive.Limits(maxExpandedBytes = 1024),
            ProjectArchive.LimitExceededException::class.java,
        )
    }

    @Test
    fun enforcesEntryLimitIncludingDirectories() {
        val limits = ProjectArchive.Limits(maxEntries = 2)
        val exact = zip("dir/" to byteArrayOf(), "dir/a" to byteArrayOf(1))
        assertEquals(2, ProjectArchive.importZip(exact.inputStream(), root, limits).entryCount)
        assertFailurePreservesExisting(
            zip("dir/" to byteArrayOf(), "dir/a" to byteArrayOf(1), "dir/b" to byteArrayOf()), limits,
            ProjectArchive.LimitExceededException::class.java,
        )
    }

    @Test
    fun enforcesPathBytesSegmentBytesAndDepth() {
        val cases = listOf(
            "a/b/c" to ProjectArchive.Limits(maxPathBytes = 4),
            "abcd" to ProjectArchive.Limits(maxSegmentBytes = 3),
            "a/b/c" to ProjectArchive.Limits(maxDepth = 2),
            "\u00e9\u00e9" to ProjectArchive.Limits(maxSegmentBytes = 3),
        )
        for ((name, limits) in cases) {
            assertFailurePreservesExisting(zip(name to byteArrayOf()), limits, ProjectArchive.LimitExceededException::class.java)
        }
    }

    @Test
    fun productionDefaultsStayFixedAndInvalidLimitsFail() {
        val limits = ProjectArchive.Limits()
        assertEquals(128L * 1024 * 1024, limits.maxCompressedBytes)
        assertEquals(512L * 1024 * 1024, limits.maxExpandedBytes)
        assertEquals(10_000, limits.maxEntries)
        assertEquals(1024, limits.maxPathBytes)
        assertEquals(255, limits.maxSegmentBytes)
        assertEquals(64, limits.maxDepth)
        assertThrows(IllegalArgumentException::class.java) { ProjectArchive.Limits(maxCompressedBytes = 0) }
        assertThrows(IllegalArgumentException::class.java) { ProjectArchive.Limits(maxExpandedBytes = -1) }
        assertThrows(IllegalArgumentException::class.java) { ProjectArchive.Limits(maxEntries = 0) }
        assertThrows(IllegalArgumentException::class.java) { ProjectArchive.Limits(maxPathBytes = 0) }
        assertThrows(IllegalArgumentException::class.java) { ProjectArchive.Limits(maxSegmentBytes = 0) }
        assertThrows(IllegalArgumentException::class.java) { ProjectArchive.Limits(maxDepth = 0) }
    }

    @Test
    fun cancellationBeforeStartingClosesInputWithoutCreatingAProject() {
        val input = TrackingInput(zip("a" to byteArrayOf(1)))
        assertThrows(ProjectArchive.ImportCancelledException::class.java) {
            ProjectArchive.importZip(input, root, isCancelled = { true })
        }
        assertTrue(input.closed)
        assertFalse(root.exists())
    }

    @Test
    fun cancellationDuringStreamingRemovesPartialFilesAndKeepsExistingProject() {
        val archive = storedZip("large.bin", ByteArray(32768) { (it % 251).toByte() })
        val input = TrackingInput(archive, maxChunk = 64)
        val existing = existingProject()
        val before = root.list()!!.toSet()
        var observedPartialFile = false
        assertThrows(ProjectArchive.ImportCancelledException::class.java) {
            ProjectArchive.importZip(input, root, isCancelled = {
                observedPartialFile = observedPartialFile || root.walkTopDown().any {
                    it.name == "large.bin" && it.length() > 0
                }
                observedPartialFile && input.bytesRead > 2048
            })
        }
        assertTrue(observedPartialFile)
        assertTrue(input.closed)
        assertEquals(before, root.list()!!.toSet())
        assertEquals("keep", existing.readText())
    }

    @Test
    fun cancellationBeforeCommitPublishesNothing() {
        val existing = existingProject()
        val before = root.list()!!.toSet()
        val input = TrackingInput(zip("a" to byteArrayOf(1)))
        assertThrows(ProjectArchive.ImportCancelledException::class.java) {
            ProjectArchive.importZip(input, root, isCancelled = { input.closed })
        }
        assertEquals(before, root.list()!!.toSet())
        assertEquals("keep", existing.readText())
    }

    @Test
    fun readAndCloseFailuresRollbackWithoutChangingExistingProjects() {
        val archive = storedZip("large.bin", ByteArray(32768))
        for (closeFailure in listOf(false, true)) {
            val input = object : ByteArrayInputStream(archive) {
                override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                    if (!closeFailure && pos > 1024) throw IOException("test read failure")
                    return super.read(buffer, offset, minOf(length, 128))
                }

                override fun close() {
                    if (closeFailure) throw IOException("test close failure")
                    super.close()
                }
            }
            val existing = existingProject()
            val before = root.list()!!.toSet()
            assertThrows(IOException::class.java) { ProjectArchive.importZip(input, root) }
            assertEquals(before, root.list()!!.toSet())
            assertEquals("keep", existing.readText())
        }
    }

    @Test
    fun rejectsRootSymlinksAndSymlinkAncestorsWithoutTouchingTargets() {
        val real = temporary.newFolder("real").canonicalFile
        val marker = File(real, "keep.txt").apply { writeText("outside") }
        val link = File(temporary.root.canonicalFile, "linked")
        Files.createSymbolicLink(link.toPath(), real.toPath())
        for (destination in listOf(link, File(link, "projects"))) {
            val input = TrackingInput(zip("a" to byteArrayOf(1)))
            assertThrows(IOException::class.java) { ProjectArchive.importZip(input, destination) }
            assertTrue(input.closed)
            assertEquals("outside", marker.readText())
            assertEquals(listOf("keep.txt"), real.list()!!.toList())
        }
    }

    @Test
    fun unrelatedSymlinksInsideRootAreNeverFollowedOrRemoved() {
        val outside = temporary.newFolder("outside").canonicalFile
        val marker = File(outside, "keep").apply { writeText("outside") }
        root.mkdirs()
        val link = File(root, "existing-link").toPath()
        Files.createSymbolicLink(link, outside.toPath())
        val before = root.list()!!.toSet()
        assertThrows(IOException::class.java) {
            ProjectArchive.importZip(zip("../existing-link/keep" to byteArrayOf()).inputStream(), root)
        }
        assertEquals(before, root.list()!!.toSet())
        assertTrue(Files.isSymbolicLink(link))
        val result = ProjectArchive.importZip(zip("existing-link/keep" to byteArrayOf(42)).inputStream(), root)
        assertTrue(Files.isRegularFile(File(result.directory, "existing-link/keep").toPath(), NOFOLLOW_LINKS))
        assertEquals("outside", marker.readText())
        assertTrue(Files.isSymbolicLink(link))
    }

    @Test
    fun archiveSymlinkMetadataProducesOnlyAnOrdinaryFile() {
        val payload = "../../outside".toByteArray()
        val archive = storedZip("link", payload)
        // Set the central entry's Unix host and symlink mode; no extraction parser is used here.
        val central = findBytes(archive, byteArrayOf(0x50, 0x4b, 0x01, 0x02))
        assertTrue(central >= 0)
        archive[central + 5] = 3
        val mode = 0xa1ff
        archive[central + 40] = mode.toByte()
        archive[central + 41] = (mode ushr 8).toByte()
        val result = ProjectArchive.importZip(archive.inputStream(), root)
        val file = File(result.directory, "link").toPath()
        assertFalse(Files.isSymbolicLink(file))
        assertTrue(Files.isRegularFile(file, NOFOLLOW_LINKS))
        assertArrayEquals(payload, Files.readAllBytes(file))
        assertFalse(file.toFile().canExecute())
    }

    private fun existingProject(): File {
        val project = File(root, "existing-project")
        project.mkdirs()
        return File(project, "keep.txt").apply { writeText("keep") }
    }

    private fun <T : IOException> assertFailurePreservesExisting(
        archive: ByteArray,
        limits: ProjectArchive.Limits = ProjectArchive.Limits(),
        expected: Class<T>,
    ) {
        val existing = existingProject()
        val before = root.list()!!.toSet()
        val input = TrackingInput(archive)
        assertThrows(expected) { ProjectArchive.importZip(input, root, limits) }
        assertTrue(input.closed)
        assertEquals(before, root.list()!!.toSet())
        assertEquals("keep", existing.readText())
    }

    private fun assertFailurePreservesExisting(archive: ByteArray) =
        assertFailurePreservesExisting(archive, expected = IOException::class.java)

    private fun zip(vararg entries: Pair<String, ByteArray>): ByteArray {
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            for ((name, bytes) in entries) {
                zip.putNextEntry(ZipEntry(name))
                zip.write(bytes)
                zip.closeEntry()
            }
        }
        return output.toByteArray()
    }

    private fun storedZip(name: String, bytes: ByteArray): ByteArray {
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            val entry = ZipEntry(name)
            entry.method = ZipEntry.STORED
            entry.size = bytes.size.toLong()
            entry.compressedSize = bytes.size.toLong()
            entry.crc = CRC32().apply { update(bytes) }.value
            zip.putNextEntry(entry)
            zip.write(bytes)
            zip.closeEntry()
        }
        return output.toByteArray()
    }

    private fun replaceName(archive: ByteArray, from: String, to: String): ByteArray {
        assertEquals(from.length, to.length)
        val result = archive.copyOf()
        val source = from.toByteArray()
        val replacement = to.toByteArray()
        var offset = findBytes(result, source)
        while (offset >= 0) {
            replacement.copyInto(result, offset)
            offset = findBytes(result, source, offset + source.size)
        }
        return result
    }

    private fun findBytes(bytes: ByteArray, needle: ByteArray, start: Int = 0): Int =
        (start..bytes.size - needle.size).firstOrNull { index ->
            needle.indices.all { bytes[index + it] == needle[it] }
        } ?: -1

    private class TrackingInput(bytes: ByteArray, private val maxChunk: Int = Int.MAX_VALUE) : InputStream() {
        private val source = ByteArrayInputStream(bytes)
        var closed = false
            private set
        var bytesRead = 0
            private set

        override fun read(): Int {
            val value = source.read()
            if (value >= 0) bytesRead++
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            val count = source.read(buffer, offset, minOf(length, maxChunk))
            if (count > 0) bytesRead += count
            return count
        }

        override fun close() {
            closed = true
            source.close()
        }
    }
}
