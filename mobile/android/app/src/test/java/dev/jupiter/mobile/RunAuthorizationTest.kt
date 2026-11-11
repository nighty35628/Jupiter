package dev.jupiter.mobile

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class RunAuthorizationTest {
    @get:Rule
    val temporary = TemporaryFolder()

    @Test
    fun requiresReadySnapshotAndBothRunIdentities() {
        val authorization = RunAuthorization("old")
        assertTrue(authorization.permits("old", "ready", "old"))
        for (phase in listOf(null, "idle", "preparing", "starting", "stopping", "fault")) {
            assertFalse(authorization.permits("old", phase, "old"))
        }
        assertFalse(authorization.permits(null, "ready", "old"))
        assertFalse(authorization.permits("new", "ready", "old"))
        assertFalse(authorization.permits("old", "ready", null))
        assertFalse(authorization.permits("old", "ready", "new"))
        assertFalse(authorization.permits("new", "ready", "new"))
        assertFalse(RunAuthorization("").permits("", "ready", ""))
    }

    @Test
    fun entryAuthorizationDoesNotAuthorizeALateReply() {
        val authorization = RunAuthorization("old")
        assertTrue(authorization.permits("old", "ready", "old"))
        assertFalse(authorization.permits("old", "stopping", "old"))
        assertFalse(authorization.permits("new", "ready", "new"))
    }

    @Test
    fun revocationCannotBeUndoneByReturningToTheSameRun() {
        val authorization = RunAuthorization("old")
        authorization.revoke()
        authorization.revoke()
        assertFalse(authorization.permits("old", "ready", "old"))
        assertTrue(RunAuthorization("old").permits("old", "ready", "old"))
    }

    @Test
    fun revokingAnOldOperationDoesNotCancelItsReplacement() {
        val oldOperation = RunAuthorization("same-run")
        val replacement = RunAuthorization("same-run")
        oldOperation.revoke()
        assertFalse(oldOperation.permits("same-run", "ready", "same-run"))
        assertTrue(replacement.permits("same-run", "ready", "same-run"))
    }

    @Test
    fun stalePickerCannotStartImportInTheNewRun() {
        val authorization = RunAuthorization("old")
        val projects = File(temporary.root.canonicalFile, "projects")
        assertThrows(ProjectArchive.ImportCancelledException::class.java) {
            ProjectArchive.importZip(archive().inputStream(), projects) {
                !authorization.permits("new", "ready", "new")
            }
        }
        assertFalse(projects.exists())
    }

    @Test
    fun runChangeDuringImportCancelsAndPreservesExistingProjects() {
        val authorization = RunAuthorization("old")
        var currentRun = "old"
        val projects = temporary.newFolder("projects").canonicalFile
        val existing = File(projects, "existing.txt").apply { writeText("keep") }
        val input = object : ByteArrayInputStream(archive()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val count = super.read(buffer, offset, length)
                currentRun = "new"
                return count
            }
        }
        assertThrows(ProjectArchive.ImportCancelledException::class.java) {
            ProjectArchive.importZip(input, projects) {
                !authorization.permits(currentRun, "ready", currentRun)
            }
        }
        assertEquals("keep", existing.readText())
        assertEquals(listOf("existing.txt"), projects.list()!!.toList())
    }

    @Test
    fun revocationDuringImportCancelsEvenIfRunIdHasNotChanged() {
        val authorization = RunAuthorization("old")
        val projects = temporary.newFolder("projects").canonicalFile
        val input = object : ByteArrayInputStream(archive()) {
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
                val count = super.read(buffer, offset, length)
                authorization.revoke()
                return count
            }
        }
        assertThrows(ProjectArchive.ImportCancelledException::class.java) {
            ProjectArchive.importZip(input, projects) {
                !authorization.permits("old", "ready", "old")
            }
        }
        assertTrue(projects.list()!!.isEmpty())
    }

    private fun archive(): ByteArray = ByteArrayOutputStream().also { bytes ->
        ZipOutputStream(bytes).use { zip ->
            zip.putNextEntry(ZipEntry("file.txt"))
            zip.write("project".toByteArray())
            zip.closeEntry()
        }
    }.toByteArray()
}
