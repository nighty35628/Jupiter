package dev.jupiter.mobile

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ImportedProjectLabelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val root: File get() = temporary.root.canonicalFile
    private fun project(): File = File(root, UUID.randomUUID().toString()).apply { mkdir() }

    @Test
    fun writesOnlyPrivateSiblingMetadataAndKeepsProjectContentsUnchanged() {
        val project = project()
        val source = File(project, "README.txt").apply { writeText("keep") }
        val name = "\u6D4B\u8BD5".repeat(50)
        ImportedProjectLabel.write(root, project.name, name) { true }
        val names = File(root, ".names")
        val label = File(names, "${project.name}.txt")
        assertEquals(name, label.readText(Charsets.UTF_8))
        assertTrue(label.length() <= 400)
        assertEquals(listOf(label.name), names.list()!!.toList())
        assertEquals(PosixFilePermissions.fromString("rwx------"), Files.getPosixFilePermissions(names.toPath(), NOFOLLOW_LINKS))
        assertEquals(PosixFilePermissions.fromString("rw-------"), Files.getPosixFilePermissions(label.toPath(), NOFOLLOW_LINKS))
        assertEquals(listOf("README.txt"), project.list()!!.toList())
        assertEquals("keep", source.readText())
    }

    @Test
    fun updatesAnExistingRegularLabelWithoutLeavingStagingFiles() {
        val project = project()
        ImportedProjectLabel.write(root, project.name, "first") { true }
        ImportedProjectLabel.write(root, project.name, "second") { true }
        assertEquals("second", File(root, ".names/${project.name}.txt").readText())
        assertEquals(1, File(root, ".names").list()!!.size)
    }

    @Test
    fun rejectsNamesDirectorySymlinkAndKeepsTheImportedProject() {
        val project = project()
        val outside = temporary.newFolder("outside")
        Files.createSymbolicLink(File(root, ".names").toPath(), outside.toPath())
        assertThrows(IllegalStateException::class.java) { ImportedProjectLabel.write(root, project.name, "name") { true } }
        assertTrue(project.isDirectory)
        assertTrue(outside.list()!!.isEmpty())
    }

    @Test
    fun rejectsTargetSymlinkWithoutFollowingIt() {
        val project = project()
        val outside = File(root, "unrelated.txt").apply { writeText("keep") }
        val names = File(root, ".names").apply { mkdir() }
        Files.createSymbolicLink(File(names, "${project.name}.txt").toPath(), outside.toPath())
        assertThrows(IllegalStateException::class.java) { ImportedProjectLabel.write(root, project.name, "name") { true } }
        assertEquals("keep", outside.readText())
        assertTrue(project.isDirectory)
    }

    @Test
    fun rejectsInvalidIdsLabelsAndNonDirectoryMetadataLocations() {
        val project = project()
        for (name in listOf("", " ", "x".repeat(101), "bad\nname")) {
            assertThrows(IllegalArgumentException::class.java) { ImportedProjectLabel.write(root, project.name, name) { true } }
        }
        assertThrows(IllegalArgumentException::class.java) { ImportedProjectLabel.write(root, "../project", "name") { true } }
        File(root, ".names").writeText("not a directory")
        assertThrows(IllegalStateException::class.java) { ImportedProjectLabel.write(root, project.name, "name") { true } }
        assertTrue(project.isDirectory)
    }

    @Test
    fun cancellationBeforeRenamePreservesTheOldLabelAndRemovesOnlyItsTemporaryFile() {
        val project = project()
        ImportedProjectLabel.write(root, project.name, "old") { true }
        val names = File(root, ".names")
        assertThrows(IOException::class.java) {
            ImportedProjectLabel.write(root, project.name, "new") {
                names.listFiles()!!.none { it.name.endsWith(".tmp") && it.length() > 0 }
            }
        }
        assertEquals("old", File(names, "${project.name}.txt").readText())
        assertEquals(1, names.list()!!.size)
        assertTrue(project.isDirectory)
    }

    @Test
    fun alreadyRevokedOperationCreatesNoMetadataAndKeepsTheProject() {
        val project = project()
        assertThrows(IOException::class.java) { ImportedProjectLabel.write(root, project.name, "name") { false } }
        assertFalse(File(root, ".names").exists())
        assertTrue(project.isDirectory)
    }
}
