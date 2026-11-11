package dev.jupiter.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Run with no engine alive: before upgrade, then after install and before first launch. */
@RunWith(AndroidJUnit4::class)
class UpgradeAuditTest {
    @Test fun upgradePreservesPrivateDataBytes() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assertEquals("Audit must only target the isolated QA package", "dev.jupiter.mobile.qa", context.packageName)
        val phase = InstrumentationRegistry.getArguments().getString("auditPhase")
        require(phase in listOf("before", "after"))
        val baseline = File(requireNotNull(context.getExternalFilesDir(null)), "upgrade-baseline.json")
        val hashes = sortedMapOf<String, String>()
        for ((name, directory) in mapOf("home" to File(context.filesDir, "home"), "workspaces" to File(context.filesDir, "workspaces"), "noBackup" to context.noBackupFilesDir)) {
            if (!directory.exists()) continue
            Files.walk(directory.toPath()).use { paths ->
                paths.forEach { path ->
                    val key = "$name/${directory.toPath().relativize(path)}"
                    if (Files.isSymbolicLink(path)) hashes[key] = "symlink:" + Files.readSymbolicLink(path).toString()
                    else if (Files.isRegularFile(path, NOFOLLOW_LINKS)) {
                        val hash = MessageDigest.getInstance("SHA-256")
                        Files.newInputStream(path, NOFOLLOW_LINKS).use { input ->
                            val buffer = ByteArray(65536)
                            while (true) { val count = input.read(buffer); if (count < 0) break; hash.update(buffer, 0, count) }
                        }
                        hashes[key] = hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                    }
                }
            }
        }
        assertTrue("Configured QA data is missing", hashes.containsKey("home/.jupiter/config.json"))
        assertFalse("Synthetic API key was stored as plaintext", File(context.filesDir, "home/.jupiter/config.json").readText().contains("sk-jupiter-isolated-synthetic-20261008-never-real"))
        if (phase == "before") {
            baseline.writeText(JSONObject(hashes as Map<*, *>).toString())
        } else {
            assertTrue("Run the before-upgrade audit first", baseline.isFile)
            val expected = JSONObject(baseline.readText())
            assertEquals("Upgrade changed the private data file set", expected.keys().asSequence().toSet(), hashes.keys)
            for ((path, digest) in hashes) assertEquals("Upgrade changed private data: $path", expected.getString(path), digest)
        }
    }
}
